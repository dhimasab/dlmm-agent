import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://opencode.ai/zen/go/v1",
  apiKey: "sk-RwbvvMkf5s8nK7XqFJlRQXlageSjMnWXWZJW1uXnlssoOd4E1CzPb2reQB0OfV1x",
  timeout: 30000,
});

(async () => {
  try {
    const response = await client.chat.completions.create({
      model: "kimi-k2.5",
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "deploy_position",
            description: "Deploy to a position",
            parameters: {
              type: "object",
              properties: {
                pool: { type: "string" },
                amount: { type: "number" },
              },
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 500,
    });
    console.log("✅ SUCCESS with tools:", response.id);
  } catch (error) {
    console.log("❌ ERROR:", error.status, error.message);
    if (error.error) console.log("Details:", error.error);
  }
})();
