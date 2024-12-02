import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AIAgent } from './agents/types';
import { createAgent } from './agents/createAgent';
import { serverClient } from './serverClient';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Map to store the AI Agent instances
// [cid: string]: AI Agent
const aiAgentCache = new Map<string, AIAgent>();
const pendingAiAgents = new Set<string>();

/**
 * Handle the request to start the AI Agent
 */
app.post('/start-ai-agent', async (req, res) => {
  const {
    channel_id,
    channel_type = 'messaging',
    platform = 'anthropic',
  } = req.body;

  // Simple validation
  if (!channel_id) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const user_id = `ai-bot-${channel_id}`;
  try {
    if (!aiAgentCache.has(user_id) && !pendingAiAgents.has(user_id)) {
      pendingAiAgents.add(user_id);

      await serverClient.upsertUser({
        id: user_id,
        name: 'AI Bot',
        role: 'admin',
      });
      const channel = serverClient.channel(channel_type, channel_id);
      await channel.addMembers([user_id]);
      await channel.watch();

      const agent = await createAgent(
        user_id,
        platform,
        channel_type,
        channel_id,
      );

      await agent.init();
      if (aiAgentCache.has(user_id)) {
        await agent.dispose();
      } else {
        aiAgentCache.set(user_id, agent);
      }
    }

    res.json({ message: 'AI Agent started', data: [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start AI Agent' });
  } finally {
    pendingAiAgents.delete(user_id);
  }
});

/**
 * Handle the request to stop the AI Agent
 */
app.post('/stop-ai-agent', async (req, res) => {
  const { channel_id, channel_type = 'messaging' } = req.body;
  const userId = `ai-bot-${channel_id}`;
  if (aiAgentCache.has(userId)) {
    const aiAgent = aiAgentCache.get(userId);
    await aiAgent!.dispose();

    const channel = serverClient.channel(channel_type, channel_id);
    await channel.removeMembers([userId]);

    aiAgentCache.delete(userId);
  }
  res.json({ message: 'AI Agent stopped', data: [] });
});

// Start the Express server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
