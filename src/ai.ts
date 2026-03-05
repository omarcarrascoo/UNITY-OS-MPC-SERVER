import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { TARGET_REPO_PATH } from './config.js';
import { agentTools, readFile, searchProject } from './tools.js';

export interface GeneratedFile { filepath: string; code: string; }
export interface AIResponse { targetRoute: string; commitMessage: string; files: GeneratedFile[]; }

export async function generateAndWriteCode(
    userPrompt: string, 
    figmaData: string | null, 
    projectTree: string 
): Promise<{ targetRoute: string, commitMessage: string }> {
    
    console.log(`🧠 AI Agent Initialized: DEEPSEEK (Agentic Mode)`);

    const figmaInstructions = figmaData ? `JSON FIGMA: ${figmaData}` : "";

    const systemPrompt = `
    You are Jarvis, an Expert Autonomous AI Software Architect for React Native (Expo).
    
    PROJECT MAP (Directory Tree):
    ${projectTree ? projectTree : "(Empty)"}
    
    ${figmaInstructions}

    YOUR OBJECTIVE:
    "${userPrompt}"
    
    AGENT RULES:
    1. You DO NOT know the contents of the files yet. You ONLY see the map above.
    2. You MUST use the 'read_file' tool to inspect a file's code before you try to edit it.
    3. If you don't know where a component is located, use the 'search_project' tool.
    4. Once you have all the context you need, you MUST output a FINAL JSON response.
    
    FINAL OUTPUT RULES (ABSOLUTE):
    When you are ready to deliver the final code, your message MUST be ONLY a valid JSON object.
    {
      "targetRoute": "/path-to-test",
      "commitMessage": "feat(profile): added delete account button",
      "files": [
        { "filepath": "app/(tabs)/index.tsx", "code": "full new code..." }
      ]
    }
    `;

    const openai = new OpenAI({ 
        baseURL: 'https://api.deepseek.com', 
        apiKey: process.env.DEEPSEEK_API_KEY as string 
    });

    const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ];

    let finalRawText = '';
    let loopCount = 0;
    const MAX_LOOPS = 100; 

    while (loopCount < MAX_LOOPS) {
        loopCount++;
        console.log(`⏳ Agent thinking... (Iteration ${loopCount})`);

        const response = await openai.chat.completions.create({
            model: 'deepseek-chat',
            messages: messages,
            tools: agentTools,
            temperature: 0.1,
            max_tokens: 8192
        });

        const msg = response.choices[0].message;
        messages.push(msg);

        if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const toolCall of msg.tool_calls) {
                const funcName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                let toolResult = "";

                if (funcName === "read_file") {
                    toolResult = readFile(args.filepath);
                } else if (funcName === "search_project") {
                    toolResult = searchProject(args.keyword);
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: funcName,
                    content: toolResult
                });
            }
        } else {
            console.log(`✅ Agent finished thinking! Delivering code...`);
            finalRawText = msg.content || '{}';
            break;
        }
    }

    if (loopCount >= MAX_LOOPS) {
        throw new Error("Agent reached maximum loop limit without returning the final JSON.");
    }

    // Extractor agresivo de JSON y limpieza
    finalRawText = finalRawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = finalRawText.indexOf('{');
    const lastBrace = finalRawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        finalRawText = finalRawText.substring(firstBrace, lastBrace + 1);
    }
    finalRawText = finalRawText.replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

    try {
        const parsedData: AIResponse = JSON.parse(finalRawText);
        const filesToCreate = parsedData.files || [];
        const targetRoute = parsedData.targetRoute || '/';
        const commitMessage = parsedData.commitMessage || 'feat: update via Jarvis Agent';

        for (const file of filesToCreate) {
            const fullPath = path.join(TARGET_REPO_PATH, file.filepath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.code);
        }
        
        console.log(`📍 Route: ${targetRoute} | 📝 Commit: ${commitMessage}`);
        return { targetRoute, commitMessage };

    } catch (error) {
        console.error("❌ RAW AI RESPONSE QUE ROMPIÓ EL JSON:\n", finalRawText);
        throw new Error("The AI failed to format the response as JSON. Please try again.");
    }
}