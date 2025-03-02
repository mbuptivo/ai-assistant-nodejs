import OpenAI from 'openai';
import { OpenAIResponseHandler } from './OpenAIResponseHandler';
import type { AIAgent } from '../types';
import type { Channel, DefaultGenerics, Event, StreamChat } from 'stream-chat';

export class OpenAIAgent implements AIAgent {
  private openai?: OpenAI;
  private assistant?: OpenAI.Beta.Assistants.Assistant;
  private openAiThread?: OpenAI.Beta.Threads.Thread;
  private lastInteractionTs = Date.now();

  private handlers: OpenAIResponseHandler[] = [];

  constructor(
    readonly chatClient: StreamChat,
    readonly channel: Channel,
  ) {}

  dispose = async () => {
    this.chatClient.off('message.new', this.handleMessage);
    await this.chatClient.disconnectUser();

    this.handlers.forEach((handler) => handler.dispose());
    this.handlers = [];
  };

  getLastInteraction = (): number => this.lastInteractionTs;

  init = async () => {
    const apiKey = process.env.OPENAI_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.openai = new OpenAI({ apiKey });

    const assitantId = process.env.OPENAI_ASSISTANT_ID as string | undefined;
    if (assitantId) {
      this.assistant = await this.openai.beta.assistants.retrieve(assitantId);
    } else {
      this.assistant = await this.openai.beta.assistants.create({
        name: 'Stream AI Assistant',
        instructions: 'You are an AI assistant. Help users with their questions.',
        tools: [
          { type: 'code_interpreter' },
          {
            type: 'function',
            function: {
              name: 'getCurrentTemperature',
              description: 'Get the current temperature for a specific location',
              parameters: {
                type: 'object',
                properties: {
                  location: {
                    type: 'string',
                    description: 'The city and state, e.g., San Francisco, CA',
                  },
                  unit: {
                    type: 'string',
                    enum: ['Celsius', 'Fahrenheit'],
                    description: "The temperature unit to use. Infer this from the user's location.",
                  },
                },
                required: ['location', 'unit'],
              },
            },
          },
        ],
        model: 'gpt-4o',
      });
    }

    const threadIdFromChannel = process.env.OPENAI_CHANNEL_THREADS as boolean | undefined;
    if (threadIdFromChannel && this.channel.data?.openaiThreadId) {
      this.openAiThread = await this.openai.beta.threads.retrieve(this.channel.data?.openaiThreadId as string);
    } else {
      this.openAiThread = await this.openai.beta.threads.create();

      if (threadIdFromChannel) {
        this.channel.updatePartial({
          set: { openaiThreadId: this.openAiThread.id },
        });
      }
    }

    if (!this.openAiThread) {
      throw new Error('Could not create or retrieve OpenAI thread');
    }

    this.chatClient.on('message.new', this.handleMessage);
  };

  private handleMessage = async (e: Event<DefaultGenerics>) => {
    if (!this.openai || !this.openAiThread || !this.assistant) {
      console.log('OpenAI not initialized');
      return;
    }

    if (!e.message || e.message.ai_generated) {
      console.log('Skip handling ai generated message');
      return;
    }

    const message = e.message.text;
    if (!message) return;

    this.lastInteractionTs = Date.now();

    await this.openai.beta.threads.messages.create(this.openAiThread.id, {
      role: 'user',
      content: message,
    });

    const { message: channelMessage } = await this.channel.sendMessage({
      text: '',
      ai_generated: true,
    });

    await this.channel.sendEvent({
      type: 'ai_indicator.update',
      ai_state: 'AI_STATE_THINKING',
      cid: channelMessage.cid,
      message_id: channelMessage.id,
    });

    const run = await this.openai.beta.threads.runs.create(this.openAiThread.id, {
      assistant_id: this.assistant.id,
      stream: true,
    });

    const handler = new OpenAIResponseHandler(this.openai, this.openAiThread, run, this.chatClient, this.channel, channelMessage);
    void handler.run();
    this.handlers.push(handler);
  };
}
