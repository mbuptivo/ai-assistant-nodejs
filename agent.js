// main.js

import 'dotenv/config';
import { Channel, StreamChat } from 'stream-chat';
import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { text } from 'express';
import axios from 'axios'

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
    tools: [
      { type: "code_interpreter" },
      {
        type: "function",
        function: {
          name: "getCurrentTemperature",
          description: "Get the current temperature for a specific location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state, e.g., San Francisco, CA",
              },
              unit: {
                type: "string",
                enum: ["Celsius", "Fahrenheit"],
                description:
                  "The temperature unit to use. Infer this from the user's location.",
              },
            },
            required: ["location", "unit"],
          },
        },
      },
    ],
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

const eventHandler = new EventHandler(openai, channel);
eventHandler.on("event", eventHandler.onEvent.bind(eventHandler));

const run = openai.beta.threads.runs.stream(thread.id, {
    assistant_id: assistant.id
  }, 
    eventHandler
  )

  run_id = run.id

  for await (const event of run) {
    eventHandler.emit("event", event);
  }
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

class EventHandler extends EventEmitter {
  constructor(client, channel) {
    super();
    this.client = client;
    this.channel = channel;
    this.message_text = '';
    this.chunk_counter = 0;
  }

  async onEvent(event) {
    try {
      // Retrieve events that are denoted with 'requires_action'
      // since these will have our tool_calls
      if (event.event === "thread.run.requires_action") {
        console.log("Requires action");
        channel.sendEvent({
          type: 'ai_indicator_changed',
          state: 'Checking external sources'
        });
        await this.handleRequiresAction(
          event.data,
          event.data.id,
          event.data.thread_id,
        );
      } else if (event.event === "thread.message.created") {
        channel.sendEvent({
          type: 'ai_indicator_changed',
          state: 'Clear'
        });
      } else if (event.event === "thread.message.delta") {
        console.log(event.data.delta.content[0].text.value);
        this.message_text += event.data.delta.content[0].text.value
        if (this.chunk_counter % 15 === 0 || this.chunk_counter === 0 || this.chunk_counter < 8) {
          var text = this.message_text
          serverClient.partialUpdateMessage(newMessage.id, {
            set: {
                text,
                generating: true
            }
          });
        }
        this.chunk_counter += 1 
      } else if (event.event === "thread.message.completed") {
        var text = this.message_text
        serverClient.partialUpdateMessage(newMessage.id, {
          set: {
              text,
              generating: false
          }
        });
      } else if (event.event === "thread.run.step.created") {
        run_id = event.data.id
      }
    } catch (error) {
      console.error("Error handling event:", error);
    }
  }

  async handleRequiresAction(data, runId, threadId) {
    try {
      const toolOutputs = await Promise.all(
        data.required_action.submit_tool_outputs.tool_calls.map(async (toolCall) => {
          if (toolCall.function.name === "getCurrentTemperature") {
            const argumentsString = toolCall.function.arguments;
            console.log("Arguments: ", argumentsString);
            const args = JSON.parse(argumentsString);
            const location = args.location;
            const unit = args.unit;
            const temperature = await this.getCurrentTemperature(location, unit);
            const temperatureString = temperature.toString();
            return {
              tool_call_id: toolCall.id,
              output: temperatureString,
            };
          }
        })
      );
      // Submit all the tool outputs at the same time
      await this.submitToolOutputs(toolOutputs, runId, threadId);
    } catch (error) {
      console.error("Error processing required action:", error);
    }
  }

  async getCurrentTemperature(location, metric) {
    try {
      const apiKey = process.env.OPENWEATHER_API_KEY;
      if (!apiKey) {
        throw new Error('OpenWeatherMap API key is missing. Set it in the .env file.');
      }
  
      const encodedLocation = encodeURIComponent(location);
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodedLocation}&units=metric&appid=${apiKey}`;
  
      const response = await axios.get(url);
      const { data } = response;
  
      if (data && data.main && typeof data.main.temp === 'number') {
        return data.main.temp;
      } else {
        throw new Error('Temperature data not found in the API response.');
      }
    } catch (error) {
      console.error(`Error fetching temperature for "${location}":`, error.message);
      throw error;
    }
  }

  async submitToolOutputs(toolOutputs, runId, threadId) {
    try {
      // Use the submitToolOutputsStream helper
      const stream = this.client.beta.threads.runs.submitToolOutputsStream(
        threadId,
        runId,
        { tool_outputs: toolOutputs },
      );
      for await (const event of stream) {
        this.emit("event", event);
      }
    } catch (error) {
      console.error("Error submitting tool outputs:", error);
    }
  }
}