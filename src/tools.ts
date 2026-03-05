import fs from 'fs';
import path from 'path';
import { TARGET_REPO_PATH } from './config.js';

// ------------------------------------------------------------------
// 1. LAS FUNCIONES FÍSICAS (Lo que se ejecuta en tu computadora)
// ------------------------------------------------------------------

export function readFile(filepath: string): string {
    try {
        const fullPath = path.join(TARGET_REPO_PATH, filepath);
        if (!fs.existsSync(fullPath)) {
            return `⚠️ Error: The file '${filepath}' does not exist. Please check the project map.`;
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        console.log(`🔍 [Tool Executed] read_file: ${filepath}`);
        return content;
    } catch (error: any) {
        return `⚠️ Error reading file: ${error.message}`;
    }
}

export function searchProject(keyword: string, dir: string = TARGET_REPO_PATH): string {
    let results = '';
    const ignoreDirs = ['node_modules', '.git', 'dist', 'ios', 'android', 'assets'];
    
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                if (!ignoreDirs.includes(item)) {
                    results += searchProject(keyword, fullPath);
                }
            } else if (/\.(js|jsx|ts|tsx)$/.test(item)) {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (content.includes(keyword)) {
                    const relativePath = path.relative(TARGET_REPO_PATH, fullPath);
                    results += `- ${relativePath}\n`;
                }
            }
        }
        
        if (dir === TARGET_REPO_PATH) {
            console.log(`🔍 [Tool Executed] search_project: "${keyword}"`);
            return results ? `Keyword '${keyword}' found in:\n${results}` : `No matches found for '${keyword}'.`;
        }
        return results;
    } catch (error: any) {
        return `⚠️ Error during search: ${error.message}`;
    }
}


// ------------------------------------------------------------------
// 2. EL ESQUEMA JSON (El "Manual de Instrucciones" para la IA)
// ------------------------------------------------------------------

export const agentTools: any[] = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Reads the exact content of a file within the project. Always use this to inspect a file's code before trying to modify it.",
            parameters: {
                type: "object",
                properties: {
                    filepath: { 
                        type: "string", 
                        description: "The relative path to the file (e.g., 'app/(tabs)/index.tsx')" 
                    }
                },
                required: ["filepath"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_project",
            description: "Searches for a specific keyword, component name, or function across the entire project. Returns a list of files where it is used.",
            parameters: {
                type: "object",
                properties: {
                    keyword: { 
                        type: "string", 
                        description: "The string or component to search for (e.g., 'ThemedButton' or 'Colors.dark')" 
                    }
                },
                required: ["keyword"]
            }
        }
    }
];