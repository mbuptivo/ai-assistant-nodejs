export interface AIAgent {
  init(): Promise<void>;
  dispose(): Promise<void>;
}

export enum AgentPlatform {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
}
