import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { getDefaultProject } from './config.js';

export interface GeneratedFile { filepath: string; code: string; }
export interface AIResponse { targetRoute: string; commitMessage: string; files: GeneratedFile[]; }

// Legacy one-shot generator that requests full-file outputs instead of search/replace patches.
export async function generateAndWriteCode(
    userPrompt: string, 
    figmaData: string | null, 
    projectContext: string
): Promise<{ targetRoute: string, commitMessage: string }> {
    const targetRepoPath = getDefaultProject().repoPath;
    const provider = process.env.AI_PROVIDER || 'gemini';
    console.log(`🧠 AI Engine Initialized: ${provider.toUpperCase()}`);

    const figmaInstructions = figmaData ? `JSON FIGMA: ${figmaData}` : "";

    const systemPrompt = `
    You are an Expert Software Architect and UI/UX Developer specializing in React Native and Expo Router.
    
    CURRENT PROJECT CODEBASE:
    ${projectContext ? projectContext : "(Empty)"}
    ${figmaInstructions}

    USER REQUEST:
    "${userPrompt}"
    
    ABSOLUTE RULE 1: Respond ONLY with a valid JSON object.
    ABSOLUTE RULE 2: The JSON object MUST follow this exact structure:
    {
      "targetRoute": "/path-to-test",
      "commitMessage": "feat(profile): added delete account button",
      "files": [
        { "filepath": "app/(tabs)/index.tsx", "code": "full code..." }
      ]
    }
    ABSOLUTE RULE 3: "commitMessage" MUST be a descriptive Conventional Commit message.
    ABSOLUTE RULE 4: "targetRoute" MUST be the exact Expo Router URL path to verify changes visually.
    ABSOLUTE RULE 5: NEVER leave code incomplete.
    `;

    let rawText = '';

    if (provider === 'gemini') {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(systemPrompt);
        rawText = result.response.text();

    } else if (provider === 'anthropic') {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY as string });
        const msg = await anthropic.messages.create({
            model: "claude-sonnet-4-5-20250929", 
            max_tokens: 8192, 
            temperature: 0.1,
            system: systemPrompt,
            messages: [{ role: "user", content: `USER REQUEST: "${userPrompt}"\n\nRemember: Respond ONLY with the valid JSON object.` }]
        });
        if (msg.content[0].type === 'text') rawText = msg.content[0].text;

    } else {
        // OpenAI-compatible providers share a common request shape via baseURL + modelName.
        let baseURL = '', apiKey = '', modelName = '';
        if (provider === 'deepseek') { baseURL = 'https://api.deepseek.com'; apiKey = process.env.DEEPSEEK_API_KEY as string; modelName = 'deepseek-reasoner'; } 
        else if (provider === 'groq') { baseURL = 'https://api.groq.com/openai/v1'; apiKey = process.env.GROQ_API_KEY as string; modelName = 'llama-3.3-70b-versatile'; } 
        else if (provider === 'openrouter') { baseURL = 'https://openrouter.ai/api/v1'; apiKey = process.env.OPENROUTER_API_KEY as string; modelName = 'qwen/qwen-2.5-coder-32b-instruct:free'; }

        const openai = new OpenAI({ baseURL, apiKey });
        const completion = await openai.chat.completions.create({
            model: modelName,
            messages: [{ role: "system", content: systemPrompt }],
            temperature: 0.1,
            max_tokens: 8192,
            ...(provider === 'deepseek' && { response_format: { type: 'json_object' } })
        });
        rawText = completion.choices[0].message?.content || '{}';
    }

    // Normalize model output before parsing: remove markdown fences, isolate JSON, strip invisible chars.
    rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        rawText = rawText.substring(firstBrace, lastBrace + 1);
    }

    rawText = rawText.replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

    try {
        const parsedData: AIResponse = JSON.parse(rawText);
        const filesToCreate = parsedData.files || [];
        const targetRoute = parsedData.targetRoute || '/';
        const commitMessage = parsedData.commitMessage || 'feat: auto-update from AI';

        for (const file of filesToCreate) {
            const fullPath = path.join(targetRepoPath, file.filepath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.code);
        }
        
        console.log(`📍 Route: ${targetRoute} | 📝 Commit: ${commitMessage}`);
        return { targetRoute, commitMessage };

    } catch (error) {
        console.error("❌ RAW AI RESPONSE QUE ROMPIÓ EL JSON:\n", rawText);
        throw new Error("The AI failed to format the response as JSON. Please try again.");
    }
}
