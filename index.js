// index.js

import 'dotenv/config';
import express from 'express';
import { StreamChat } from 'stream-chat';
import { main } from './agent.js';
import { messageNewHandler } from './agent.js';
import { stopGeneratingHandler } from './agent.js';

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

var map = new Map();

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const serverClient = StreamChat.getInstance(apiKey, apiSecret);
const user_id = "ai-bot"

// Define the POST endpoint
app.post('/start-ai-agent', async (req, res) => {
  const { channel_id } = req.body;

  // Simple validation
  if (!channel_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    if (!map.has(channel_id)) {
      const client = await createAndConnectClient(user_id);
      map.set(channel_id, client);
      const channel = serverClient.channel('messaging', channel_id, {});
      await channel.watch();
      main(channel, client);
    }

    // Respond with success and message details
    res.json({
      message: 'AI Agent started',
      data: [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start AI Agent' });
  }
});

app.post('/stop-ai-agent', async (req, res) => {
  const { channel_id } = req.body;
  if (map.has(channel_id)) {
    stopWatching(channel_id, map.get(channel_id));
    map.delete(channel_id);
    res.json({
      message: 'AI Agent stopped',
      data: [],
    });
  } else {
    res.status(400).json({ error: 'Channel not found' });
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

export async function createAndConnectClient(user_id) {
  // Generate a token for the user
  const token = serverClient.createToken(user_id);

  // Upsert the user (creates or updates the user)
  await serverClient.upsertUser({ id: user_id, role: "ai_bot" });

  // Initialize the client-side client
  const client = StreamChat.getInstance(apiKey);

  // Connect the user
  await client.connectUser({ id: user_id }, token);

  console.log(`User ${user_id} connected successfully.`);

  return client;
}

export async function stopWatching(channel_id, client) {
  console.log(`Stopping watching channel ${channel_id}`);
  const channel = client.channel('messaging', channel_id, {});
  await channel.stopWatching();
  await channel.removeMembers([user_id]);
  client.off('message.new', messageNewHandler);
  client.off('stop_generating', stopGeneratingHandler);
  client.disconnectUser();
}