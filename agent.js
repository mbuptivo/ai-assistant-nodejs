// main.js

import 'dotenv/config';
import { Channel, StreamChat } from 'stream-chat';
import OpenAI from 'openai';
import { text } from 'express';

// Initialize the Stream Chat client
const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const serverClient = StreamChat.getInstance(apiKey, apiSecret);

// Initialize the OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

var thread;
var channel;
var newMessage;

const assistant = await openai.beta.assistants.create({
    name: "Stream AI Assistant",
    instructions: "You are an AI assistant. Help users with their questions.",
    tools: [{ type: "code_interpreter" }],
    model: "gpt-4o"
});

var run_id = '';

// Define the main processing function
export async function main(channel, client) {
    setupAgent(channel, client);
}

export async function handleMessage(message, thread, channel) {
  const aiMessage = await openai.beta.threads.messages.create(
    thread.id,
    {
      role: "user",
      content: message
    }
);

newMessage = (await channel.sendMessage({
  text: '',
  ai_generated: true
})).message;
 
channel.sendEvent({
  type: 'ai_indicator_changed',
  state: 'Thinking'
});

var message_text = '';
var chunk_counter = 0

const run = openai.beta.threads.runs.stream(thread.id, {
    assistant_id: assistant.id
  })
  .on('textCreated', (text) => {
    
    channel.sendEvent({
      type: 'ai_indicator_changed',
      state: 'Clear'
    });
  })
  .on('textDelta', (textDelta, snapshot) => {
    message_text += textDelta.value
    if (chunk_counter % 15 === 0 || chunk_counter === 0) {
      var text = message_text
      serverClient.partialUpdateMessage(newMessage.id, {
        set: {
            text
        }
      });
    }
    chunk_counter += 1    
  })
  .on('textDone', (content, snapshot) => {
    var text = message_text
    serverClient.partialUpdateMessage(newMessage.id, {
      set: {
          text
      }
    });
  })
  .on('toolCallCreated', (toolCall) => process.stdout.write(`\nassistant > ${toolCall.type}\n\n`))
  .on('runStepCreated', (runStep) => run_id = runStep.run_id)
  .on('toolCallDelta', (toolCallDelta, snapshot) => {
    if (toolCallDelta.type === 'code_interpreter') {
      if (toolCallDelta.code_interpreter.input) {
        process.stdout.write(toolCallDelta.code_interpreter.input);
      }
      if (toolCallDelta.code_interpreter.outputs) {
        process.stdout.write("\noutput >\n");
        toolCallDelta.code_interpreter.outputs.forEach(output => {
          if (output.type === "logs") {
            process.stdout.write(`\n${output.logs}\n`);
          }
        });
      }
    }
  });

  run_id = run.id
}

export async function setupAgent(agentChannel, client) {
  try {
    thread = await openai.beta.threads.create();
    channel = agentChannel;

    client.on('message.new', messageNewHandler);
    client.on('stop_generating', stopGeneratingHandler);
  } catch (error) {
    console.error('Error setting up user:', error);
  }
}

export const messageNewHandler = (event) => {
  console.log('New message:', event.message.text);
  if (event.message.ai_generated === true) {
    process.stdout.write("Skip handling ai generated message\n");
    return;
  }
  handleMessage(event.message.text, thread, channel);
};

export const stopGeneratingHandler = (event) => {
  process.stdout.write("Stop generating\n")
  openai.beta.threads.runs.cancel(thread.id, run_id);
};