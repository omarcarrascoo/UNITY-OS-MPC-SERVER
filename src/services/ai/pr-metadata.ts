import { createDeepseekChatCompletion } from './client.js';

export async function generatePRMetadata(diff: string): Promise<string> {
  const prompt = `You are an expert developer. I will provide you with a git diff of the work done in this session.
Please generate a conventional commit message that summarizes ALL the changes comprehensively.
Format it as a single string where the first line is the conventional commit title, followed by a blank line, and then a brief bulleted list of the key changes.

GIT DIFF:
${diff.substring(0, 6000)}`;

  try {
    const response = await createDeepseekChatCompletion({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content?.trim() || 'feat: accumulated session updates';
  } catch (error) {
    console.error('Error generating Smart PR:', error);
    return 'feat: accumulated session updates';
  }
}
