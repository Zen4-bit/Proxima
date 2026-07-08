// Proxima — MCP Code Tools.
// Registers tools for code verification, explanation, generation, optimization, reviews, fixing errors, and security audits.

import { createPromptRunner } from './_shared.js';

export function register(server, deps) {
    const {
        z, toolResponse, toolError,
        smartChat, readFileContents, resolveProvider,
    } = deps;

    const runPrompt = createPromptRunner({ resolveProvider, smartChat, toolResponse, toolError });


    const ANALYSIS = Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    });


    const PROVIDER_DESC = 'AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select best for coding.';

    server.registerTool('verify_code', {
        title: 'Verify Code',
        description: 'Quick best-practices check of a code snippet for a stated purpose (bugs, security, improvements). For a whole file/folder use analyze_file; for a deep vulnerability audit use security_audit.',
        inputSchema: {
            purpose: z.string().describe('Description of what the code should do'),
            code: z.string().optional().describe('Optional code snippet to verify'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ purpose, code, provider: pn }) =>
        runPrompt(pn, 'coding', () => code
            ? `Verify this code follows best practices for: ${purpose}\n\nCode:\n${code}\n\nCheck for bugs, security issues, and improvements.`
            : `What are the best practices and common patterns for: ${purpose}`)
    );

    server.registerTool('explain_code', {
        title: 'Explain Code',
        description: 'Explain a code snippet (or files) in detail, line by line. Use this to understand existing code; use analyze_file for large files/whole codebases.',
        inputSchema: {
            code: z.string().optional().describe('The code snippet to explain (or use files parameter)'),
            language: z.string().optional().describe('Programming language'),
            files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to explain'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ code, language, files, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const lang = language ? ` (${language})` : '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${code || ''}` : (code || '');
            return `Explain this code${lang} in detail, line by line:\n\n${fullCode}`;
        })
    );

    server.registerTool('generate_code', {
        title: 'Generate Code',
        description: 'Write new, production-ready code from a description (with comments, error handling, usage examples). For converting existing code use convert_code; for fixing an error use fix_error.',
        inputSchema: {
            description: z.string().describe('What the code should do'),
            language: z.string().optional().describe('Programming language (default: JavaScript)'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ description, language, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const lang = language || 'JavaScript';
            return `Write production-ready ${lang} code that: ${description}\n\nInclude comments, error handling, and usage examples. No placeholders.`;
        })
    );

    server.registerTool('optimize_code', {
        title: 'Optimize Code',
        description: 'Improve existing code for a goal (speed, memory, readability) and show before/after. For correctness bugs use fix_error; for security use security_audit.',
        inputSchema: {
            code: z.string().optional().describe('Code to optimize (or use files parameter)'),
            goal: z.string().optional().describe('Optimization goal'),
            files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to optimize'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ code, goal, files, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const g = goal ? ` for ${goal}` : '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${code || ''}` : (code || '');
            return `Optimize this code${g}. Show before/after with explanations:\n\n${fullCode}`;
        })
    );

    server.registerTool('review_code', {
        title: 'Review Code (snippet)',
        description: 'Review a code snippet for bugs, security, performance and best practices. For a single file on disk use review_code_file; for a folder use analyze_file.',
        inputSchema: {
            code: z.string().optional().describe('Code to review (or use files parameter)'),
            context: z.string().optional().describe('Context about the code'),
            files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to review'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ code, context, files, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const ctx = context ? ` Context: ${context}` : '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${code || ''}` : (code || '');
            return `Review this code for bugs, security issues, performance, and best practices.${ctx}\n\n${fullCode}`;
        })
    );

    server.registerTool('solve', {
        title: 'Solve Coding Task',
        description: 'End-to-end solve a coding task/feature/bug with full working code. Broadest tool: use generate_code for greenfield code, fix_error for a specific error message.',
        inputSchema: {
            task: z.string().describe('What to solve — coding task, bug, feature, anything'),
            files: z.array(z.string()).optional().describe('Optional: file paths for context'),
            language: z.string().optional().describe('Programming language if relevant'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ task, files, language, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const context = files && files.length > 0 ? (readFileContents(files) || '') : '';
            const langHint = language ? ` (Language: ${language})` : '';
            return `You are a senior software engineer. Solve this task completely.${langHint}\n\nTASK: ${task}\n${context ? `\nCODE CONTEXT:\n${context}` : ''}\n\nProvide:\n1. Brief analysis of the problem\n2. Complete working solution with full code\n3. Explanation of key decisions\n4. Any edge cases or gotchas to watch for\n\nBe thorough and production-ready. Do not use placeholder code.`;
        })
    );

    server.registerTool('fix_error', {
        title: 'Fix Error',
        description: 'Diagnose a specific error message/stack trace and give the exact fix (root cause → fix → prevention → full code). For a general explanation only, use explain_error.',
        inputSchema: {
            error: z.string().describe('Error message or stack trace'),
            file: z.string().optional().describe('File path where the error occurs'),
            context: z.string().optional().describe('Additional context about what you were doing'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ error, file, context: ctx, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const fileContent = file ? (readFileContents([file]) || '') : '';
            return `You are a debugging expert. Fix this error completely.\n\nERROR:\n${error}\n${ctx ? `\nCONTEXT: ${ctx}` : ''}${fileContent ? `\nSOURCE CODE:\n${fileContent}` : ''}\n\nProvide:\n1. ROOT CAUSE: Why this error happens (be specific)\n2. FIX: The exact code changes needed (show before/after)\n3. PREVENTION: How to prevent this in the future\n4. FULL FIXED CODE: Complete corrected code ready to use\n\nDo not give vague advice. Give the exact fix.`;
        })
    );

    server.registerTool('build_architecture', {
        title: 'Build Architecture',
        description: 'Design a complete, production-ready system architecture (stack, schema, APIs, deployment) from a project description.',
        inputSchema: {
            description: z.string().describe('What you want to build'),
            constraints: z.string().optional().describe('Tech constraints (e.g., "must use Next.js, PostgreSQL")'),
            scale: z.string().optional().describe('Expected scale (e.g., "10k users", "enterprise")'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ description, constraints, scale, provider: pn }) =>
        runPrompt(pn, 'coding', () =>
            `You are a senior software architect. Design a complete architecture for this project.\n\nPROJECT: ${description}\n${constraints ? `CONSTRAINTS: ${constraints}` : ''}${scale ? `\nSCALE: ${scale}` : ''}\n\nProvide a complete, production-ready architecture:\n1. TECH STACK: Every technology with justification\n2. FOLDER STRUCTURE: Complete directory tree with file descriptions\n3. DATABASE SCHEMA: Full schema with tables, columns, types, relations\n4. API ENDPOINTS: Complete REST/GraphQL API design\n5. COMPONENT TREE: Frontend component hierarchy\n6. AUTH & SECURITY: Authentication strategy, security measures\n7. DEPLOYMENT: Hosting, CI/CD, environment setup\n8. THIRD-PARTY SERVICES: Any external APIs or services needed\n\nBe exhaustive. A developer should be able to start coding immediately from this blueprint.`)
    );

    server.registerTool('write_tests', {
        title: 'Write Tests',
        description: 'Generate a complete test file for the code in a given file path (happy path + edge cases + error scenarios).',
        inputSchema: {
            file: z.string().describe('File path to generate tests for'),
            framework: z.string().optional().describe('Test framework (jest, vitest, mocha, pytest). Default: auto-detect'),
            focus: z.string().optional().describe('Focus area: unit, integration, edge-cases, all'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ file, framework, focus, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const fileContent = readFileContents([file]);
            if (!fileContent) return { direct: 'Could not read file: ' + file };
            const fw = framework || 'auto-detect from the code';
            const focusArea = focus || 'comprehensive (unit + edge cases)';
            return `You are a testing expert. Write complete tests for this code.\n\n${fileContent}\n\nTEST FRAMEWORK: ${fw}\nFOCUS: ${focusArea}\n\nRequirements:\n1. Cover ALL exported functions/classes/methods\n2. Include happy path + edge cases + error scenarios\n3. Use descriptive test names\n4. Include setup/teardown if needed\n5. Mock external dependencies properly\n6. Aim for high coverage\n\nReturn ONLY the complete test file code, ready to save and run.`;
        })
    );

    server.registerTool('explain_error', {
        title: 'Explain Error',
        description: 'Explain an error in plain language with likely causes and step-by-step fixes. For the exact code fix instead, use fix_error.',
        inputSchema: {
            error: z.string().describe('Error message or stack trace to explain'),
            context: z.string().optional().describe('What you were doing when the error occurred'),
            provider: z.string().optional().describe('AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select.'),
        },
        annotations: ANALYSIS,
    }, async ({ error, context: ctx, provider: pn }) =>
        runPrompt(pn, 'general', () =>
            `Explain this error in simple terms and provide step-by-step fix instructions.\n\nERROR:\n${error}\n${ctx ? `\nCONTEXT: ${ctx}` : ''}\n\nProvide:\n1. WHAT HAPPENED: Plain English explanation (no jargon)\n2. WHY: The most common causes (ranked by likelihood)\n3. HOW TO FIX: Step-by-step fix instructions for each cause\n4. QUICK FIX: The single most likely fix in one code snippet\n\nBe practical and specific. Not theory — actual commands and code.`)
    );

    server.registerTool('convert_code', {
        title: 'Convert Code',
        description: 'Translate existing code from one language/framework to another, preserving all functionality. For writing new code from scratch use generate_code.',
        inputSchema: {
            file: z.string().optional().describe('File path to convert'),
            code: z.string().optional().describe('Code snippet to convert (if no file)'),
            from: z.string().optional().describe('Source language/framework (auto-detected if not specified)'),
            to: z.string().describe('Target language/framework (e.g., "TypeScript", "Python/FastAPI", "Vue 3")'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ file, code, from, to, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            let sourceCode = code || '';
            if (file) sourceCode = readFileContents([file]) || sourceCode;
            if (!sourceCode) return { direct: 'No code provided. Use file path or code parameter.' };
            const fromHint = from ? `from ${from} ` : '';
            return `Convert this code ${fromHint}to ${to}. Preserve ALL functionality.\n\nSOURCE CODE:\n${sourceCode}\n\nRequirements:\n1. Maintain the exact same logic and behavior\n2. Use idiomatic patterns for ${to}\n3. Handle framework-specific differences\n4. Add necessary imports/dependencies\n5. Include comments where conversion required significant changes\n\nReturn the complete converted code, ready to use.`;
        })
    );

    server.registerTool('security_audit', {
        title: 'Security Audit',
        description: 'Deep security audit of code (injection, auth, secrets, crypto, config, deps) with severity, location and fixes. For general code review use review_code.',
        inputSchema: {
            code: z.string().optional().describe('Code to audit for security vulnerabilities'),
            files: z.array(z.string()).optional().describe('Optional: file paths to audit'),
            language: z.string().optional().describe('Programming language'),
            provider: z.string().optional().describe(PROVIDER_DESC),
        },
        annotations: ANALYSIS,
    }, async ({ code, files, language, provider: pn }) =>
        runPrompt(pn, 'coding', () => {
            const lang = language ? ` (${language})` : '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${code || ''}` : (code || '');
            if (!fullCode.trim()) return { direct: 'No code provided. Pass code or files parameter.' };
            return `You are a senior security engineer. Perform a thorough security audit of this code${lang}.\n\nCODE:\n${fullCode}\n\nCheck for ALL of the following:\n1. **Injection vulnerabilities** (SQL, XSS, command injection, LDAP, etc.)\n2. **Authentication/Authorization flaws**\n3. **Data exposure** (hardcoded secrets, PII leaks)\n4. **Input validation** (missing sanitization)\n5. **Cryptographic issues** (weak algorithms)\n6. **Configuration problems** (debug mode, CORS)\n7. **Dependency risks**\n\nFor each issue:\n- **Severity**: CRITICAL / HIGH / MEDIUM / LOW\n- **Location**: Line or function\n- **Description**: What the vulnerability is\n- **Fix**: Exact code fix\n\nEnd with a security score (0-100) and summary.`;
        })
    );
}
