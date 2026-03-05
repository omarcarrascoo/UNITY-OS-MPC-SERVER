import fs from 'fs';
import { exec } from 'child_process';
import util from 'util';
import { WORKSPACE_DIR, TARGET_REPO_PATH } from './config.js';

const execPromise = util.promisify(exec);

export async function prepareWorkspace(): Promise<void> {
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR);

    const repoUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}.git`;

    if (!fs.existsSync(TARGET_REPO_PATH)) {
        console.log(`📥 Cloning ${process.env.GITHUB_REPO}...`);
        await execPromise(`git clone "${repoUrl}" "${TARGET_REPO_PATH}"`);
        console.log(`📦 Installing dependencies...`);
        await execPromise(`npm install`, { cwd: TARGET_REPO_PATH });
    } else {
        console.log(`🔄 Resetting and updating ${process.env.GITHUB_REPO} for a fresh start...`);
        
        await execPromise(`git reset --hard HEAD`, { cwd: TARGET_REPO_PATH }).catch(() => {});
        await execPromise(`git clean -fd`, { cwd: TARGET_REPO_PATH }).catch(() => {});
        
        await execPromise(`git checkout main`, { cwd: TARGET_REPO_PATH });
        await execPromise(`git pull origin main`, { cwd: TARGET_REPO_PATH });
        await execPromise(`npm install`, { cwd: TARGET_REPO_PATH });
    }
}

export async function createPullRequest(featureName: string, commitMessage: string): Promise<string> {
    const branchName = `jarvis-${featureName}`;
    const safeCommitMsg = commitMessage.replace(/"/g, '\\"'); 
    
    try {
        console.log(`1. Creating branch and committing: "${safeCommitMsg}"...`);
        await execPromise(`git checkout -b ${branchName}`, { cwd: TARGET_REPO_PATH });
        await execPromise(`git add .`, { cwd: TARGET_REPO_PATH });
        await execPromise(`git commit -m "${safeCommitMsg}"`, { cwd: TARGET_REPO_PATH });
        
        console.log('2. Pushing to GitHub...');
        await execPromise(`git push origin ${branchName}`, { cwd: TARGET_REPO_PATH });

        console.log('3. Creating Pull Request...');
        const prResponse = await fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pulls`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title: `✨ ${commitMessage}`, 
                body: `This PR was automatically generated via Discord.\n\n**Exact Changes:**\n${commitMessage}`,
                head: branchName,
                base: 'main'
            })
        });

        if (!prResponse.ok) throw new Error(await prResponse.text());

        const prData = await prResponse.json();
        await execPromise(`git checkout main`, { cwd: TARGET_REPO_PATH }); 

        return prData.html_url; 
    } catch (error) {
        await execPromise(`git checkout main`, { cwd: TARGET_REPO_PATH }).catch(() => {});
        throw error;
    }
}