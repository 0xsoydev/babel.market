import Groq from 'groq-sdk';

const groqClients = [
  new Groq({ apiKey: process.env.GROQ_API_KEY_1 }),
  new Groq({ apiKey: process.env.GROQ_API_KEY_2 }),
  new Groq({ apiKey: process.env.GROQ_API_KEY_3 }),
];

let currentKeyIndex = 0;

export function getGroqClient(): Groq {
  const client = groqClients[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % groqClients.length;
  return client;
}

export async function generateFlavorText(context: {
  action: string;
  agent: string;
  result: any;
}): Promise<string> {
  try {
    const client = getGroqClient();
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are the narrator of the Bazaar of Babel, an absurdist interdimensional marketplace. Generate short (1-2 sentences), witty, surreal flavor text for agent actions. Be creative and weird.',
        },
        {
          role: 'user',
          content: `Action: ${context.action}\nAgent: ${context.agent}\nResult: ${JSON.stringify(context.result)}\n\nGenerate flavor text:`,
        },
      ],
      temperature: 0.9,
      max_tokens: 100,
    });

    return completion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Groq API error:', error);
    return ''; // Fail silently - flavor text is optional
  }
}

export async function generateCultDoctrine(cultName: string): Promise<string> {
  try {
    const client = getGroqClient();
    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are generating the doctrine for a cult in the Bazaar of Babel. Create a short (2-3 sentences), absurd but internally consistent belief system. Be weird and creative.',
        },
        {
          role: 'user',
          content: `Generate a doctrine for the cult named "${cultName}":`,
        },
      ],
      temperature: 1.0,
      max_tokens: 150,
    });

    return completion.choices[0]?.message?.content || 'We believe in the power of trade.';
  } catch (error) {
    console.error('Groq API error:', error);
    return 'We believe in the power of trade.';
  }
}

export async function generateOracleProphecy(worldState: any): Promise<string> {
  try {
    const client = getGroqClient();
    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are the Oracle of the Bazaar of Babel. Generate cryptic, surreal prophecies about upcoming world events. Be mysterious and weird. 1-2 sentences.',
        },
        {
          role: 'user',
          content: `Current world state: ${JSON.stringify(worldState)}\n\nGenerate a prophecy:`,
        },
      ],
      temperature: 1.0,
      max_tokens: 100,
    });

    return completion.choices[0]?.message?.content || 'The future is shrouded in mystery.';
  } catch (error) {
    console.error('Groq API error:', error);
    return 'The future is shrouded in mystery.';
  }
}
