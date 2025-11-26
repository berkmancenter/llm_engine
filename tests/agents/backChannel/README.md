## Testing prompt changes against participant data

### Prep Export dev server mongo collections and import locally (at minimum you need baseusers, conversations, messages, and channels)

### Steps (for each run)

1. Drop the agent-generated messages from database:
   db.messages.deleteMany({fromAgent: true})
2. Generate new insights (use this exact command, only changing the mongo URL):
   NODE_ENV=development MONGODB_URL=mongodb://127.0.0.1:27017/llm_engine node --loader ts-node/esm tests/agents/backChannel/generateInsights.ts {{conversationId}} {{agentId}} "{{js date string}}"
3. Produce report of insights:
   NODE_ENV=development MONGODB_URL=mongodb://127.0.0.1:27017/llm_engine
   node --loader ts-node/esm tests/agents/backChannel/backChannelInsightsData.ts {{conversationId}}
