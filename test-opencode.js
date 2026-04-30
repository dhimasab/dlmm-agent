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
      messages: [{ role: "user", content: "hello world test" }],
      temperature: 0.7,
      max_tokens: 500,
    });
    console.log("✅ SUCCESS:", response.id);
  } catch (error) {
    console.log("❌ ERROR:", error.status, error.message);
    console.log("Body:", JSON.stringify(error.error || {}));
  }
})();
