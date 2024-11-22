// index.js

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { StreamChat } from 'stream-chat';
import { main } from './agent.js';
import { messageNewHandler } from './agent.js';
import { stopGeneratingHandler } from './agent.js';

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

const corsOptions = {
  // Either leave it as * or change it to the URL of the frontend app.
  // e.g.: origin: 'http://localhost:3001'
  origin: '*',
};
app.use(cors(corsOptions));
var map = new Map();

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const serverClient = StreamChat.getInstance(apiKey, apiSecret);
const user_id = 'ai-bot';

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
      await channel.addMembers([user_id]);
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
    map.delete(channel_id);
  } else {
    // Only log this here, since we still want to stop watching the channel
    // This might happen if the AI bot was not added during this instance of
    // the session.
    console.log('Channel not found');
  }
  await stopWatching(channel_id, serverClient);
  res.json({
    message: 'AI Agent stopped',
    data: [],
  });
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

export async function createAndConnectClient(user_id) {
  // Generate a token for the user
  const token = serverClient.createToken(user_id);

  // Upsert the user (creates or updates the user)
  await serverClient.upsertUser({ id: user_id, role: 'admin' });

  // Initialize the client-side client
  const client = StreamChat.getInstance(apiKey);

  // Connect the user
  await client.connectUser({ id: user_id }, token);

  console.log(`User ${user_id} connected successfully.`);

  return client;
}

export async function stopWatching(channel_id, client) {
  try {
    console.log(`Stopping watching channel ${channel_id}`);
    const channel = client.channel('messaging', channel_id, {});
    await channel.stopWatching();
    await channel.removeMembers([user_id]);
    client.off('message.new', messageNewHandler);
    client.off('stop_generating', stopGeneratingHandler);
    await client.disconnectUser();
  } catch (error) {
    console.error(`Error stopping watching channel ${channel_id}: ${error}`);
  }
}
