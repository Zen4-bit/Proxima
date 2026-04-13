const DEFAULT_FILE_ATTACHMENT_INDICATORS = [
    '[data-testid*="attachment"]',
    '[data-testid*="file"]',
    '[aria-label*="attachment"]',
    '[aria-label*="file"]',
    '[aria-label*="Remove"]',
    '.attachment',
    '.file-chip',
    'button[aria-label*="Remove"]',
    '[data-filename]',
    '.uploaded-file',
    '[data-testid="file-thumbnail"]',
    '[data-testid="composer-attachment"]',
    '.file-preview-container'
];

const DOM_TO_MARKDOWN_HELPERS = `
    const NL = String.fromCharCode(10);

    function domToMarkdown(element) {
        if (!element) return '';

        let markdown = '';
        const children = element.childNodes;

        for (let i = 0; i < children.length; i++) {
            const node = children[i];

            if (node.nodeType === 3) {
                markdown += node.textContent;
                continue;
            }

            if (node.nodeType !== 1) continue;

            const tag = node.tagName.toLowerCase();

            if (node.style && node.style.display === 'none') continue;
            if (node.classList && node.classList.contains('sr-only')) continue;

            if (tag === 'pre') {
                const codeEl = node.querySelector('code');
                const codeText = codeEl ? codeEl.innerText : node.innerText;
                let lang = '';
                const langClass = node.className.match(/language-(\\w+)/) ||
                    (codeEl && codeEl.className.match(/language-(\\w+)/));
                if (langClass) lang = langClass[1];
                const langSpan = node.querySelector('[class*="lang"], [class*="language"]');
                if (!lang && langSpan) {
                    lang = langSpan.textContent.trim().toLowerCase();
                }
                const parentLang = node.closest('[class*="language-"]');
                if (!lang && parentLang) {
                    const match = parentLang.className.match(/language-(\\w+)/);
                    if (match) lang = match[1];
                }
                markdown += NL + NL + '\`\`\`' + lang + NL + codeText.trim() + NL + '\`\`\`' + NL + NL;
                continue;
            }

            if (tag === 'code' && !node.closest('pre')) {
                markdown += '\`' + node.textContent + '\`';
                continue;
            }

            if (tag === 'h1') {
                markdown += NL + NL + '# ' + domToMarkdown(node) + NL + NL;
                continue;
            }
            if (tag === 'h2') {
                markdown += NL + NL + '## ' + domToMarkdown(node) + NL + NL;
                continue;
            }
            if (tag === 'h3') {
                markdown += NL + NL + '### ' + domToMarkdown(node) + NL + NL;
                continue;
            }
            if (tag === 'h4') {
                markdown += NL + NL + '#### ' + domToMarkdown(node) + NL + NL;
                continue;
            }

            if (tag === 'p') {
                markdown += NL + NL + domToMarkdown(node) + NL + NL;
                continue;
            }

            if (tag === 'strong' || tag === 'b') {
                markdown += '**' + domToMarkdown(node) + '**';
                continue;
            }

            if (tag === 'em' || tag === 'i') {
                markdown += '*' + domToMarkdown(node) + '*';
                continue;
            }

            if (tag === 'a') {
                const href = node.getAttribute('href');
                const text = domToMarkdown(node);
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                    markdown += '[' + text + '](' + href + ')';
                } else {
                    markdown += text;
                }
                continue;
            }

            if (tag === 'ul' || tag === 'ol') {
                markdown += NL;
                const items = node.querySelectorAll(':scope > li');
                items.forEach((li, idx) => {
                    const prefix = tag === 'ol' ? (idx + 1) + '. ' : '- ';
                    markdown += prefix + domToMarkdown(li).trim() + NL;
                });
                markdown += NL;
                continue;
            }

            if (tag === 'li') {
                markdown += domToMarkdown(node);
                continue;
            }

            if (tag === 'br') {
                markdown += NL;
                continue;
            }

            if (tag === 'hr') {
                markdown += NL + NL + '---' + NL + NL;
                continue;
            }

            if (tag === 'blockquote') {
                const lines = domToMarkdown(node).split(NL);
                markdown += NL + lines.map((line) => '> ' + line).join(NL) + NL;
                continue;
            }

            if (tag === 'table') {
                const rows = node.querySelectorAll('tr');
                rows.forEach((row, rowIdx) => {
                    const cells = row.querySelectorAll('th, td');
                    const cellTexts = Array.from(cells).map((cell) => cell.textContent.trim());
                    markdown += '| ' + cellTexts.join(' | ') + ' |' + NL;
                    if (rowIdx === 0 && row.querySelector('th')) {
                        markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |' + NL;
                    }
                });
                markdown += NL;
                continue;
            }

            if (tag === 'div' || tag === 'span' || tag === 'section' || tag === 'article') {
                markdown += domToMarkdown(node);
                continue;
            }

            markdown += domToMarkdown(node);
        }

        return markdown;
    }

    function cleanMarkdown(md) {
        const excessiveNL = new RegExp(NL + '{4,}', 'g');
        return md
            .replace(excessiveNL, NL + NL + NL)
            .replace(/^\\s+/, '')
            .replace(/\\s+$/, '')
            .trim();
    }
`;

const RESPONSE_CAPTURE_SCRIPTS = {
    perplexity: `
        (function() {
            const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                .filter((block) => {
                    const text = block.textContent.trim();
                    return text.length > 3 &&
                        !text.toLowerCase().includes('perplexity pro') &&
                        !text.includes('Ask anything') &&
                        !text.includes('Ask a follow-up') &&
                        !text.includes('Attach');
                });

            if (proseBlocks.length > 0) {
                const lastBlock = proseBlocks[proseBlocks.length - 1];
                return {
                    count: proseBlocks.length,
                    fingerprint: lastBlock.textContent.substring(0, 200).trim()
                };
            }

            return { count: 0, fingerprint: '' };
        })()
    `,
    chatgpt: `
        (function() {
            const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (assistantMsgs.length > 0) {
                const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                const text = (lastMsg.innerText || lastMsg.textContent || '').trim();
                return text.substring(0, 200);
            }

            const articles = document.querySelectorAll('article');
            if (articles.length > 0) {
                const lastArticle = articles[articles.length - 1];
                const text = (lastArticle.innerText || lastArticle.textContent || '').trim();
                return text.substring(0, 200);
            }

            return '';
        })()
    `,
    claude: `
        (function() {
            const selectors = [
                '[data-is-streaming]',
                '.font-claude-message',
                '[class*="claude"][class*="message"]',
                '[class*="response"][class*="content"]',
                '[class*="assistant"][class*="message"]'
            ];

            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    return elements[elements.length - 1].textContent.substring(0, 200).trim();
                }
            }

            const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
            if (proseBlocks.length > 0) {
                return proseBlocks[proseBlocks.length - 1].textContent.substring(0, 200).trim();
            }

            return '';
        })()
    `,
    gemini: `
        (function() {
            const selectors = [
                'message-content',
                '.message-content',
                '[class*="response-content"]',
                '.model-response',
                '[class*="model-response"]',
                '[class*="markdown"]'
            ];

            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    const lastElement = elements[elements.length - 1];
                    const text = (lastElement.innerText || lastElement.textContent || '').trim();
                    if (text.length > 10) {
                        return text.substring(0, 200);
                    }
                }
            }

            return '';
        })()
    `,
    deepseek: `
        (function() {
            const assistantMessages = Array.from(document.querySelectorAll('div.ds-message'))
                .filter((element) => !!element.querySelector('.ds-markdown'));

            if (assistantMessages.length > 0) {
                const lastMessage = assistantMessages[assistantMessages.length - 1];
                const text = (lastMessage.innerText || lastMessage.textContent || '').trim();
                if (text.length > 10) {
                    return text.substring(0, 200);
                }
            }

            const markdownBlocks = document.querySelectorAll('.ds-markdown');
            if (markdownBlocks.length > 0) {
                const lastBlock = markdownBlocks[markdownBlocks.length - 1];
                const text = (lastBlock.innerText || lastBlock.textContent || '').trim();
                if (text.length > 10) {
                    return text.substring(0, 200);
                }
            }

            return '';
        })()
    `,
    grok: `
        (function() {
            const assistantBlocks = Array.from(document.querySelectorAll('.response-content-markdown'))
                .filter((element) => {
                    const wrapper = element.closest('.group');
                    const wrapperClass = String(wrapper?.className || '');
                    const text = (element.innerText || element.textContent || '').trim();
                    return wrapperClass.includes('items-start') && text.length > 2;
                });

            if (assistantBlocks.length > 0) {
                const lastBlock = assistantBlocks[assistantBlocks.length - 1];
                const text = (lastBlock.innerText || lastBlock.textContent || '').trim();
                if (text.length > 10) {
                    return text.substring(0, 200);
                }
            }

            const assistantBubbles = Array.from(document.querySelectorAll('.message-bubble'))
                .filter((element) => {
                    const wrapper = element.closest('.group');
                    const wrapperClass = String(wrapper?.className || '');
                    const text = (element.innerText || element.textContent || '').trim();
                    return wrapperClass.includes('items-start') && text.length > 2;
                });

            if (assistantBubbles.length > 0) {
                const lastBubble = assistantBubbles[assistantBubbles.length - 1];
                const text = (lastBubble.innerText || lastBubble.textContent || '').trim();
                if (text.length > 10) {
                    return text.substring(0, 200);
                }
            }

            return '';
        })()
    `,
    zai: `
        (function() {
            const assistantBlocks = Array.from(document.querySelectorAll('.chat-assistant, [class*="message-"] .chat-assistant'));

            for (let i = assistantBlocks.length - 1; i >= 0; i--) {
                const clone = assistantBlocks[i].cloneNode(true);
                clone.querySelectorAll('.thinking-chain-container, [class*="thinking"], [class*="reason"], button, details, summary').forEach((element) => element.remove());
                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > 0) {
                    return text.substring(0, 200);
                }
            }

            const paragraphs = Array.from(document.querySelectorAll('.chat-assistant p'))
                .map((element) => (element.innerText || element.textContent || '').trim())
                .filter((text) => text.length > 0);

            if (paragraphs.length > 0) {
                return paragraphs[paragraphs.length - 1].substring(0, 200);
            }

            return '';
        })()
    `,
    copilot: `
        (function() {
            const aiMessages = Array.from(document.querySelectorAll(
                '[data-testid="ai-message"], [data-testid*="ai-message"], [data-content="ai-message"], [class*="assistant"][class*="message"]'
            ));

            for (let i = aiMessages.length - 1; i >= 0; i--) {
                const clone = aiMessages[i].cloneNode(true);
                clone.querySelectorAll('[data-testid="message-item-reactions"], [data-testid="citation-overflow-button"], button').forEach((element) => element.remove());
                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > 10) {
                    return text.substring(0, 200);
                }
            }

            return '';
        })()
    `,
    metaai: `
        (function() {
            const assistantMessages = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'));

            for (let i = assistantMessages.length - 1; i >= 0; i--) {
                const clone = assistantMessages[i].cloneNode(true);
                clone.querySelectorAll('button, [role="button"], [class*="group/starter"], [class*="scrollbar-none"]').forEach((element) => element.remove());
                const text = (clone.innerText || clone.textContent || '').trim();
                if (text.length > 0) {
                    return text.substring(0, 200);
                }
            }

            const markdownBlocks = Array.from(document.querySelectorAll(
                '[data-testid="assistant-message"] .markdown-content, [data-testid="assistant-message"] .ur-markdown'
            ));
            for (let i = markdownBlocks.length - 1; i >= 0; i--) {
                const text = (markdownBlocks[i].innerText || markdownBlocks[i].textContent || '').trim();
                if (text.length > 0) {
                    return text.substring(0, 200);
                }
            }

            return '';
        })()
    `,
    qwen: `
        (function() {
            const assistantMessages = Array.from(document.querySelectorAll('.qwen-chat-message-assistant'));

            for (let i = assistantMessages.length - 1; i >= 0; i--) {
                const markdownBlock = assistantMessages[i].querySelector(
                    '.response-message-content .custom-qwen-markdown, .response-message-content .qwen-markdown, .response-message-content'
                );
                const text = (markdownBlock?.innerText || markdownBlock?.textContent || '').trim();
                if (text.length > 0 && !/^thinking\\.{0,3}$/i.test(text)) {
                    return text.substring(0, 200);
                }
            }

            return '';
        })()
    `
};

const RESPONSE_EXTRACTION_BODIES = {
    chatgpt: `
        const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (assistantMsgs.length > 0) {
            const lastMsg = assistantMsgs[assistantMsgs.length - 1];
            const markdown = cleanMarkdown(domToMarkdown(lastMsg));
            if (markdown && markdown.length > 0) return markdown;
        }

        const articles = document.querySelectorAll('article');
        for (let j = articles.length - 1; j >= 0; j--) {
            const article = articles[j];
            const content = article.querySelector('.prose, .markdown, [class*="markdown"]');
            if (!content) continue;

            const markdown = cleanMarkdown(domToMarkdown(content));
            if (markdown && markdown.length > 0 && !markdown.includes('__oai_')) {
                return markdown;
            }
        }

        return '';
    `,
    perplexity: `
        const allProseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
            .filter((block) => {
                const text = block.textContent.trim();
                return text.length > 3 &&
                    !text.toLowerCase().includes('perplexity pro') &&
                    !text.includes('Ask anything') &&
                    !text.includes('Ask a follow-up') &&
                    !text.includes('Attach');
            });

        if (allProseBlocks.length > 0) {
            const lastBlock = allProseBlocks[allProseBlocks.length - 1];
            let bestContainer = lastBlock;
            let parent = lastBlock.parentElement;
            const getNormalizedText = (element) => (element?.textContent || '').replace(/\\s+/g, ' ').trim();
            const hasExternalQueryHeading = (root, container) => Array.from(root.querySelectorAll('h1'))
                .some((heading) => !container.contains(heading) && getNormalizedText(heading).length > 0);

            for (let i = 0; i < 10 && parent; i++) {
                if (parent.tagName === 'MAIN' || parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
                if (parent.querySelector('textarea, input[type="text"], [role="textbox"], [contenteditable="true"]')) break;
                if (hasExternalQueryHeading(parent, bestContainer)) break;

                const parentLength = getNormalizedText(parent).length;
                const currentLength = getNormalizedText(bestContainer).length;
                if (parentLength > currentLength && parentLength < 50000) {
                    bestContainer = parent;
                }

                parent = parent.parentElement;
            }

            const markdown = cleanMarkdown(domToMarkdown(bestContainer));
            if (markdown && markdown.length > 5) {
                return markdown;
            }
        }

        return '';
    `,
    claude: `
        let chatResponse = '';
        let artifactCode = '';

        const turnSelectors = [
            '[data-testid="chat-message-turn"]',
            '[data-testid="assistant-turn"]',
            '[data-testid="ai-message"]',
            'div[data-turn-role="assistant"]',
            'div[data-role="assistant"]',
            'div[data-message-role="assistant"]'
        ];

        for (const selector of turnSelectors) {
            const turns = document.querySelectorAll(selector);
            if (turns.length > 0) {
                const lastTurn = turns[turns.length - 1];
                const markdown = cleanMarkdown(domToMarkdown(lastTurn));
                if (markdown && markdown.length > chatResponse.length) {
                    chatResponse = markdown;
                }
            }
        }

        if (chatResponse.length < 50) {
            const chatSelectors = [
                '[data-is-streaming]',
                '.font-claude-message',
                '[class*="claude"][class*="message"]',
                '[class*="response"][class*="content"]',
                '[class*="assistant"][class*="message"]'
            ];

            for (const selector of chatSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    const lastElement = elements[elements.length - 1];
                    const markdown = cleanMarkdown(domToMarkdown(lastElement));
                    if (markdown && markdown.length > chatResponse.length) {
                        chatResponse = markdown;
                    }
                }
            }
        }

        if (chatResponse.length < 50) {
            const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
            if (proseBlocks.length > 0) {
                const lastBlock = proseBlocks[proseBlocks.length - 1];
                const markdown = cleanMarkdown(domToMarkdown(lastBlock));
                if (markdown && markdown.length > chatResponse.length) {
                    chatResponse = markdown;
                }
            }
        }

        if (chatResponse.length < 50) {
            const allDivs = document.querySelectorAll('div[class]');
            const candidates = [];

            for (const div of allDivs) {
                const text = div.innerText || '';
                if (text.length < 100) continue;

                const sidebarKeywords = ['New chat', 'Chats', 'Projects', 'Recents', 'All chats', 'Free plan', 'Artifacts', 'Hide', 'Code'];
                let sidebarScore = 0;
                for (const keyword of sidebarKeywords) {
                    if (text.includes(keyword)) sidebarScore++;
                }
                if (sidebarScore >= 3) continue;

                if (div.closest('nav, header, footer, aside, [class*="sidebar"], [class*="nav"], [class*="menu"], [class*="drawer"], [class*="panel"][class*="left"]')) continue;
                const className = div.className || '';
                if (className.includes('sidebar') || className.includes('nav') || className.includes('menu') || className.includes('drawer') || className.includes('conversation-list')) continue;
                if (div.querySelector('textarea, input[type="text"]')) continue;
                if (text.includes('Claude can make mistakes') && text.length < 200) continue;

                candidates.push({ el: div, text, len: text.length });
            }

            candidates.sort((a, b) => a.len - b.len);
            for (const candidate of candidates) {
                if (candidate.len > 100 && candidate.len < 5000) {
                    chatResponse = cleanMarkdown(candidate.text);
                    break;
                }
            }

            if (chatResponse.length < 50 && candidates.length > 0) {
                chatResponse = cleanMarkdown(candidates[candidates.length - 1].text);
            }
        }

        if (chatResponse.length > 0) {
            const timestampPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
            if (timestampPattern.test(chatResponse)) {
                const splitPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
                const parts = chatResponse.split(splitPattern);
                let lastResponse = '';

                for (let i = parts.length - 1; i >= 0; i--) {
                    const part = (parts[i] || '').trim();
                    if (!part || part.length < 20) continue;
                    if (part === 'AM' || part === 'PM') continue;
                    lastResponse = part;
                    break;
                }

                if (lastResponse.length > 20) {
                    chatResponse = cleanMarkdown(lastResponse);
                }
            }
        }

        const artifactSelectors = [
            '[data-testid="artifact-view"]',
            '[class*="artifact-renderer"]',
            '[class*="artifact-content"]',
            '[class*="artifact"][class*="panel"]',
            '[class*="artifact"][class*="viewer"]',
            '[class*="code-editor"]',
            '[class*="artifact"]'
        ];

        let artifactPanel = null;
        let artifactTitle = '';

        for (const selector of artifactSelectors) {
            const panels = document.querySelectorAll(selector);
            if (panels.length > 0) {
                artifactPanel = panels[panels.length - 1];
                const titleElement = artifactPanel.querySelector('[class*="title"], [class*="name"], [class*="header"] span, h1, h2, h3');
                if (titleElement) artifactTitle = titleElement.textContent.trim();
                break;
            }
        }

        if (artifactPanel) {
            const codeElements = artifactPanel.querySelectorAll('pre code, pre, code, [class*="code-block"], [class*="CodeMirror"], [class*="monaco"]');
            for (const codeElement of codeElements) {
                const codeText = codeElement.innerText || codeElement.textContent || '';
                if (codeText.trim().length > artifactCode.length) {
                    artifactCode = codeText.trim();
                }
            }

            if (artifactCode.length < 10) {
                const panelText = artifactPanel.innerText || '';
                if (panelText.length > 50) {
                    artifactCode = panelText;
                }
            }
        }

        if (artifactCode.length < 10) {
            const allPreformatted = document.querySelectorAll('pre, code');
            let biggestCode = '';
            for (const pre of allPreformatted) {
                const text = pre.innerText || '';
                if (text.length > 100 && text.length > biggestCode.length) {
                    biggestCode = text;
                }
            }
            if (biggestCode.length > 100) {
                artifactCode = biggestCode;
            }
        }

        const artifactButtons = document.querySelectorAll('button[class*="artifact"], [class*="artifact-block"], [data-component-name*="Artifact"]');
        const artifactTitles = [];
        artifactButtons.forEach((button) => {
            const title = button.textContent.trim();
            if (title && title.length > 2 && title.length < 200) {
                artifactTitles.push(title);
            }
        });

        let fullResponse = chatResponse;

        if (artifactCode && artifactCode.length > 10) {
            let lang = '';
            const titleLower = (artifactTitle || '').toLowerCase();
            if (titleLower.includes('.jsx') || titleLower.includes('.tsx') || titleLower.includes('react')) lang = 'jsx';
            else if (titleLower.includes('.js')) lang = 'javascript';
            else if (titleLower.includes('.ts')) lang = 'typescript';
            else if (titleLower.includes('.py')) lang = 'python';
            else if (titleLower.includes('.html')) lang = 'html';
            else if (titleLower.includes('.css')) lang = 'css';
            else if (titleLower.includes('.json')) lang = 'json';
            else if (titleLower.includes('.md')) lang = 'markdown';

            if (artifactTitle) {
                fullResponse += NL + NL + '**Artifact: ' + artifactTitle + '**' + NL;
            }
            fullResponse += NL + '\`\`\`' + lang + NL + artifactCode + NL + '\`\`\`' + NL;
        }

        if (artifactTitles.length > 0 && artifactCode.length < 10) {
            fullResponse += NL + NL + '**Artifacts created:**' + NL;
            artifactTitles.forEach((title) => {
                fullResponse += '- ' + title + NL;
            });
        }

        if (fullResponse && fullResponse.length > 0) {
            return cleanMarkdown(fullResponse);
        }

        return '';
    `,
    gemini: `
        const messageContent = document.querySelectorAll('message-content, .message-content, [class*="response-content"]');
        if (messageContent.length > 0) {
            const lastMessage = messageContent[messageContent.length - 1];
            const markdown = cleanMarkdown(domToMarkdown(lastMessage));
            if (markdown && markdown.length > 0) return markdown;
        }

        const modelResponses = document.querySelectorAll('.model-response, [class*="model-response"], [class*="response-container"]');
        if (modelResponses.length > 0) {
            const lastResponse = modelResponses[modelResponses.length - 1];
            const markdown = cleanMarkdown(domToMarkdown(lastResponse));
            if (markdown && markdown.length > 0) return markdown;
        }

        const markdownContainers = document.querySelectorAll('[class*="markdown"], .markdown-content');
        if (markdownContainers.length > 0) {
            const lastMarkdown = markdownContainers[markdownContainers.length - 1];
            const markdown = cleanMarkdown(domToMarkdown(lastMarkdown));
            if (markdown && markdown.length > 0) return markdown;
        }

        const responseContent = document.querySelectorAll('[class*="response"][class*="content"]');
        if (responseContent.length > 0) {
            const lastResponse = responseContent[responseContent.length - 1];
            const markdown = cleanMarkdown(domToMarkdown(lastResponse));
            if (markdown && markdown.length > 0) return markdown;
        }

        return '';
    `,
    deepseek: `
        const assistantMessages = Array.from(document.querySelectorAll('div.ds-message'))
            .filter((element) => !!element.querySelector('.ds-markdown'));

        for (let i = assistantMessages.length - 1; i >= 0; i--) {
            const assistantMessage = assistantMessages[i];
            const markdown = cleanMarkdown(domToMarkdown(assistantMessage));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        const markdownBlocks = document.querySelectorAll('.ds-markdown');
        for (let i = markdownBlocks.length - 1; i >= 0; i--) {
            const markdownBlock = markdownBlocks[i];
            const markdown = cleanMarkdown(domToMarkdown(markdownBlock));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        return '';
    `,
    grok: `
        const assistantBlocks = Array.from(document.querySelectorAll('.response-content-markdown'))
            .filter((element) => {
                const wrapper = element.closest('.group');
                const wrapperClass = String(wrapper?.className || '');
                const text = (element.innerText || element.textContent || '').trim();
                return wrapperClass.includes('items-start') && text.length > 0;
            });

        for (let i = assistantBlocks.length - 1; i >= 0; i--) {
            const assistantBlock = assistantBlocks[i];
            const markdown = cleanMarkdown(domToMarkdown(assistantBlock));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        const assistantBubbles = Array.from(document.querySelectorAll('.message-bubble'))
            .filter((element) => {
                const wrapper = element.closest('.group');
                const wrapperClass = String(wrapper?.className || '');
                const text = (element.innerText || element.textContent || '').trim();
                return wrapperClass.includes('items-start') && text.length > 0;
            });

        for (let i = assistantBubbles.length - 1; i >= 0; i--) {
            const assistantBubble = assistantBubbles[i];
            const markdown = cleanMarkdown(domToMarkdown(assistantBubble));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        return '';
    `,
    zai: `
        const assistantBlocks = Array.from(document.querySelectorAll('.chat-assistant, [class*="message-"] .chat-assistant'));

        for (let i = assistantBlocks.length - 1; i >= 0; i--) {
            const clone = assistantBlocks[i].cloneNode(true);
            clone.querySelectorAll('.thinking-chain-container, [class*="thinking"], [class*="reason"], button, details, summary').forEach((element) => element.remove());
            const markdown = cleanMarkdown(domToMarkdown(clone));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        const paragraphs = Array.from(document.querySelectorAll('.chat-assistant p'))
            .map((element) => (element.innerText || element.textContent || '').trim())
            .filter((text) => text.length > 0);

        if (paragraphs.length > 0) {
            return cleanMarkdown(paragraphs[paragraphs.length - 1]);
        }

        return '';
    `,
    copilot: `
        const aiMessages = Array.from(document.querySelectorAll(
            '[data-testid="ai-message"], [data-testid*="ai-message"], [data-content="ai-message"], [class*="assistant"][class*="message"]'
        ));

        for (let i = aiMessages.length - 1; i >= 0; i--) {
            const clone = aiMessages[i].cloneNode(true);
            clone.querySelectorAll('[data-testid="message-item-reactions"], [data-testid="citation-overflow-button"], button').forEach((element) => element.remove());
            const markdown = cleanMarkdown(domToMarkdown(clone))
                .replace(/^Copilot said\\s*/i, '')
                .trim();
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        return '';
    `,
    metaai: `
        const assistantMessages = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'));

        for (let i = assistantMessages.length - 1; i >= 0; i--) {
            const clone = assistantMessages[i].cloneNode(true);
            clone.querySelectorAll('button, [role="button"], [class*="group/starter"], [class*="scrollbar-none"]').forEach((element) => element.remove());

            const markdownBlock = clone.querySelector('.markdown-content, .ur-markdown');
            const markdown = cleanMarkdown(domToMarkdown(markdownBlock || clone));
            if (markdown && markdown.length > 0) {
                return markdown;
            }
        }

        return '';
    `,
    qwen: `
        const assistantMessages = Array.from(document.querySelectorAll('.qwen-chat-message-assistant'));

        for (let i = assistantMessages.length - 1; i >= 0; i--) {
            const clone = assistantMessages[i].cloneNode(true);
            const hasImageCard = !!clone.querySelector('.chat-response-media-render img.qwen-image, img[src*="/t2i/"], img[src*="/image_gen/"]');
            clone.querySelectorAll(
                '.qwen-chat-thinking-tool-status-card-wraper, .qwen-chat-status-card, .response-message-footer, .qwen-chat-package-comp-new-action-control, button, [role="button"]'
            ).forEach((element) => element.remove());

            const markdownBlock = clone.querySelector(
                '.response-message-content .custom-qwen-markdown, .response-message-content .qwen-markdown, .response-message-content'
            );
            if (!markdownBlock && hasImageCard) {
                return '';
            }
            const markdown = cleanMarkdown(domToMarkdown(markdownBlock || clone));
            if (markdown && markdown.length > 0 && !/^thinking\\.{0,3}$/i.test(markdown)) {
                return markdown;
            }
        }

        return '';
    `
};

const RESPONSE_MEDIA_ROOT_SELECTORS = {
    chatgpt: [
        '[data-message-author-role="assistant"]',
        'article'
    ],
    claude: [
        '[data-testid="assistant-turn"]',
        '[data-testid="ai-message"]',
        'div[data-turn-role="assistant"]',
        '[data-is-streaming]',
        '.font-claude-message',
        '.prose',
        '[class*="prose"]'
    ],
    gemini: [
        'message-content',
        '.message-content',
        '.model-response',
        '[class*="model-response"]',
        '[class*="response-container"]',
        '[class*="markdown"]'
    ],
    deepseek: [
        'div.ds-message',
        '.ds-markdown'
    ],
    grok: [
        '.response-content-markdown',
        '.message-bubble'
    ],
    zai: [
        '.chat-assistant',
        '[class*="message-"] .chat-assistant'
    ],
    copilot: [
        '[data-testid="ai-message"]',
        '[data-testid*="ai-message"]',
        '[data-content="ai-message"]',
        '[class*="assistant"][class*="message"]'
    ],
    metaai: [
        '[data-testid="assistant-message"]'
    ],
    qwen: [
        '.qwen-chat-message-assistant',
        '.chat-response-message',
        '.response-message-content'
    ],
    perplexity: [
        'main [class*="prose"]:not(.prose-sm)',
        '[class*="prose"]:not(.prose-sm)'
    ]
};

const RESPONSE_MEDIA_IMAGE_SELECTORS = {
    metaai: [
        'img[data-testid="generated-image"]'
    ],
    qwen: [
        '#chat-message-container > .qwen-chat-message-assistant:last-child .chat-response-media-render img.qwen-image',
        '#chat-message-container > .qwen-chat-message-assistant:last-child img[src*="/t2i/"]',
        '#chat-message-container > .qwen-chat-message-assistant:last-child img[src*="/image_gen/"]'
    ]
};

const HUMAN_VERIFICATION_HINTS = [
    'verify you are a human',
    'verify you are human',
    'complete the security check',
    'complete the verification',
    'human verification',
    'are you a human',
    'verify you are not a robot',
    'press and hold'
];

const STRUCTURED_RESPONSE_HELPERS = `
    function isVisibleNode(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
    }

    function uniqueElements(elements) {
        const seen = new Set();
        const unique = [];

        for (const element of elements) {
            if (!element || seen.has(element)) continue;
            seen.add(element);
            unique.push(element);
        }

        return unique;
    }

    function getProviderLabel(providerId) {
        const labels = {
            chatgpt: 'ChatGPT',
            claude: 'Claude',
            gemini: 'Gemini',
            deepseek: 'DeepSeek',
            grok: 'Grok',
            zai: 'Z.ai',
            copilot: 'Copilot',
            metaai: 'Meta AI',
            qwen: 'Qwen',
            perplexity: 'Perplexity'
        };

        return labels[providerId] || providerId;
    }

    function getMediaRoots(providerId) {
        const selectors = PROVIDER_MEDIA_ROOT_SELECTORS[providerId] || [];
        const roots = [];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach((element) => {
                if (!element || !isVisibleNode(element)) {
                    return;
                }

                roots.push(element);
            });
        }

        return uniqueElements(roots);
    }

    function collectExplicitResponseImages(providerId) {
        const selectors = PROVIDER_MEDIA_IMAGE_SELECTORS[providerId] || [];
        const explicitImages = [];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach((img) => {
                if (!img || !isVisibleNode(img)) {
                    return;
                }

                explicitImages.push(img);
            });
        }

        return uniqueElements(explicitImages);
    }

    function normalizeImageNode(img) {
        const rect = img.getBoundingClientRect();
        return {
            src: img.currentSrc || img.src || '',
            alt: (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim(),
            width: Math.round(Math.max(img.naturalWidth || 0, rect.width || 0)),
            height: Math.round(Math.max(img.naturalHeight || 0, rect.height || 0))
        };
    }

    function isUsableResponseImage(img) {
        if (!isVisibleNode(img)) {
            return false;
        }

        const rect = img.getBoundingClientRect();
        const width = Math.max(img.naturalWidth || 0, rect.width || 0);
        const height = Math.max(img.naturalHeight || 0, rect.height || 0);
        const src = img.currentSrc || img.src || '';
        const alt = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim().toLowerCase();
        const className = String(img.className || '').toLowerCase();

        if (!src) {
            return false;
        }

        if (width < 96 && height < 96) {
            return false;
        }

        if (alt.includes('avatar') || alt.includes('profile picture')) {
            return false;
        }

        if (alt.includes('loading') || className.includes('loading') || className.includes('spinner')) {
            return false;
        }

        if (className.includes('avatar') || className.includes('icon') || className.includes('emoji')) {
            return false;
        }

        return true;
    }

    function collectResponseImages(providerId) {
        const explicitImages = collectExplicitResponseImages(providerId)
            .filter(isUsableResponseImage)
            .map(normalizeImageNode);

        if (explicitImages.length > 0) {
            return explicitImages.slice(-8);
        }

        const roots = getMediaRoots(providerId);

        for (let i = roots.length - 1; i >= 0; i--) {
            const images = Array.from(roots[i].querySelectorAll('img'))
                .filter(isUsableResponseImage)
                .map(normalizeImageNode);

            if (images.length > 0) {
                return images.slice(0, 8);
            }
        }

        return [];
    }

    function detectHumanVerification(providerId) {
        const bodyText = String(document.body?.innerText || document.body?.textContent || '')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();

        const matchedHint = HUMAN_VERIFICATION_HINTS.find((hint) => bodyText.includes(hint));
        const mentionsCaptcha = bodyText.includes('captcha') || bodyText.includes('recaptcha');
        const hasChallengeWidget = !!document.querySelector(
            'iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[src*="recaptcha" i], iframe[src*="arkoselabs" i], iframe[title*="captcha" i], iframe[title*="challenge" i], [id*="captcha" i], [class*="captcha" i], [class*="challenge-platform" i], [data-testid*="captcha" i]'
        );
        const urlLooksLikeChallenge = /captcha|challenge|recaptcha/i.test(window.location.href || '');

        if (!matchedHint && !hasChallengeWidget && !(urlLooksLikeChallenge && mentionsCaptcha)) {
            return null;
        }

        return {
            kind: 'human_verification',
            message: getProviderLabel(providerId) + ' requires human verification in Proxima. Complete the check in the app, then retry.'
        };
    }
`;

const TYPING_DETECTION_BODIES = {
    chatgpt: `
        const stopButton = document.querySelector('button[aria-label*="Stop"]');
        const streamingDots = document.querySelector('[class*="streaming"]');
        const thinkingIndicator = document.querySelector('[class*="typing"], [class*="thinking"]');
        const resultStreaming = document.querySelector('[data-message-author-role="assistant"] [class*="result-streaming"]');

        if (stopButton || streamingDots || thinkingIndicator || resultStreaming) {
            return { isTyping: true, provider: 'chatgpt' };
        }

        return { isTyping: false };
    `,
    claude: `
        const stopButton = document.querySelector('button[aria-label="Stop generating"], button[aria-label="Stop Response"], button[aria-label="Stop"]');
        const streamingIndicator = document.querySelector('[data-is-streaming="true"]');
        const loadingSpinner = document.querySelector('.animate-spin, [class*="loading-spinner"], [class*="animate-pulse"]');
        const artifactProgress = document.querySelector('[class*="artifact"][class*="loading"], [class*="artifact"][class*="progress"], [class*="generating"]');
        const statusText = document.querySelector('[class*="status"], [class*="thinking"]');
        const isThinking = statusText && (statusText.textContent.includes('thinking') || statusText.textContent.includes('writing') || statusText.textContent.includes('Generating'));

        if (stopButton && stopButton.offsetParent !== null) {
            return { isTyping: true, provider: 'claude' };
        }
        if (streamingIndicator) {
            return { isTyping: true, provider: 'claude' };
        }
        if (loadingSpinner && loadingSpinner.offsetParent !== null) {
            return { isTyping: true, provider: 'claude' };
        }
        if (artifactProgress) {
            return { isTyping: true, provider: 'claude' };
        }
        if (isThinking) {
            return { isTyping: true, provider: 'claude' };
        }

        return { isTyping: false };
    `,
    perplexity: `
        const stopButton = document.querySelector('button[aria-label="Stop"]');
        if (stopButton && stopButton.offsetParent !== null) {
            return { isTyping: true, provider: 'perplexity' };
        }

        const searchingIndicator = document.querySelector('[data-testid*="searching"], [class*="searching"]');
        if (searchingIndicator) {
            return { isTyping: true, provider: 'perplexity' };
        }

        const spinners = document.querySelectorAll('.animate-spin, [class*="animate-pulse"], [class*="loading"], [class*="spinner"], [class*="progress"]');
        for (const spinner of spinners) {
            if (spinner.offsetParent !== null && !spinner.closest('nav, header, [class*="sidebar"], [class*="nav"]')) {
                return { isTyping: true, provider: 'perplexity' };
            }
        }

        const thinkingDots = document.querySelector('[class*="thinking"], [class*="typing"], [class*="generating"], [class*="streaming"]');
        if (thinkingDots && thinkingDots.offsetParent !== null) {
            return { isTyping: true, provider: 'perplexity' };
        }

        const stepIndicators = document.querySelectorAll('[class*="step"], [class*="source"]');
        for (const indicator of stepIndicators) {
            const text = indicator.textContent || '';
            if ((text.includes('Searching') || text.includes('Reading') || text.includes('Analyzing') || text.includes('Thinking')) && indicator.offsetParent !== null) {
                return { isTyping: true, provider: 'perplexity' };
            }
        }

        const animatedSvg = document.querySelector('svg[class*="animate"], circle[class*="animate"], svg.animate-spin');
        if (animatedSvg && animatedSvg.closest('[class*="prose"], [class*="answer"], [class*="response"], main') && animatedSvg.offsetParent !== null) {
            return { isTyping: true, provider: 'perplexity' };
        }

        return { isTyping: false };
    `,
    gemini: `
        const stopButton = document.querySelector('button[aria-label="Stop"], button[aria-label="Stop generating"]');
        const matSpinner = document.querySelector('mat-spinner');

        if (stopButton && stopButton.offsetParent !== null) {
            return { isTyping: true, provider: 'gemini' };
        }
        if (matSpinner && matSpinner.offsetParent !== null) {
            return { isTyping: true, provider: 'gemini' };
        }

        return { isTyping: false };
    `,
    deepseek: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'deepseek' };
        }

        const loadingIndicators = Array.from(document.querySelectorAll(
            '[class*="loading"], [class*="typing"], [class*="stream"], [class*="pulse"], [class*="spin"]'
        )).some((element) => isVisible(element) && element.closest('div.ds-message'));

        if (loadingIndicators) {
            return { isTyping: true, provider: 'deepseek' };
        }

        const statusText = Array.from(document.querySelectorAll('div, span, p'))
            .filter((element) => isVisible(element))
            .map((element) => (element.textContent || '').trim())
            .find((text) => text.length > 0 && text.length < 120 && /thinking|searching|reading|analyzing/i.test(text));

        if (statusText) {
            return { isTyping: true, provider: 'deepseek' };
        }

        return { isTyping: false };
    `,
    grok: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'grok' };
        }

        const stopButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find((element) => isVisible(element) && /stop/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.innerText || element.textContent || '')));

        if (stopButton) {
            return { isTyping: true, provider: 'grok' };
        }

        const loadingIndicators = Array.from(document.querySelectorAll(
            '[class*="loading"], [class*="typing"], [class*="stream"], [class*="skeleton"], [class*="animate"]'
        )).some((element) => {
            if (!isVisible(element)) return false;
            const wrapper = element.closest('.group');
            return String(wrapper?.className || '').includes('items-start');
        });

        if (loadingIndicators) {
            return { isTyping: true, provider: 'grok' };
        }

        const statusText = Array.from(document.querySelectorAll('div, span, p'))
            .filter((element) => isVisible(element))
            .map((element) => (element.textContent || '').trim())
            .find((text) => text.length > 0 && text.length < 120 && /thinking|analyzing|searching|reasoning/i.test(text));

        if (statusText) {
            return { isTyping: true, provider: 'grok' };
        }

        const assistantGroups = Array.from(document.querySelectorAll('.group'))
            .filter((element) => String(element.className || '').includes('items-start'));
        const lastAssistantGroup = assistantGroups[assistantGroups.length - 1];

        if (lastAssistantGroup) {
            const responseBlock = lastAssistantGroup.querySelector('.response-content-markdown');
            const responseText = (responseBlock?.innerText || responseBlock?.textContent || '').trim();
            const actionButtons = lastAssistantGroup.querySelector('.action-buttons');
            const hasVisibleActionButtons = !!actionButtons &&
                Array.from(actionButtons.querySelectorAll('button, [role="button"]')).some(isVisible);

            if (!hasVisibleActionButtons && responseText.length === 0) {
                return { isTyping: true, provider: 'grok' };
            }
        }

        return { isTyping: false };
    `,
    zai: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'zai' };
        }

        const loadingIndicators = Array.from(document.querySelectorAll(
            '[class*="loading"], [class*="typing"], [class*="stream"], [class*="animate"], [class*="skeleton"]'
        )).some((element) => isVisible(element) && !!element.closest('.chat-assistant, [class*="message-"]'));

        if (loadingIndicators) {
            return { isTyping: true, provider: 'zai' };
        }

        const assistantBlocks = Array.from(document.querySelectorAll('.chat-assistant, [class*="message-"] .chat-assistant'));
        const lastAssistantBlock = assistantBlocks[assistantBlocks.length - 1];
        if (lastAssistantBlock) {
            const clone = lastAssistantBlock.cloneNode(true);
            clone.querySelectorAll('.thinking-chain-container, button').forEach((element) => element.remove());
            const finalText = (clone.innerText || clone.textContent || '').trim();
            const hasVisibleThinkingChain = Array.from(lastAssistantBlock.querySelectorAll('.thinking-chain-container'))
                .some(isVisible);

            if (hasVisibleThinkingChain && finalText.length === 0) {
                return { isTyping: true, provider: 'zai' };
            }
        }

        return { isTyping: false };
    `,
    copilot: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'copilot' };
        }

        const stopButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find((element) => isVisible(element) && /stop/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.innerText || element.textContent || '')));
        if (stopButton) {
            return { isTyping: true, provider: 'copilot' };
        }

        const loadingIndicators = Array.from(document.querySelectorAll(
            '[class*="loading"], [class*="typing"], [class*="stream"], [class*="animate"], [data-testid*="loading"]'
        )).some((element) => isVisible(element) && !element.closest('nav, header, [role="navigation"]'));

        if (loadingIndicators) {
            return { isTyping: true, provider: 'copilot' };
        }

        const aiMessages = Array.from(document.querySelectorAll('[data-testid="ai-message"]'));
        const lastAiMessage = aiMessages[aiMessages.length - 1];
        if (lastAiMessage) {
            const text = (lastAiMessage.innerText || lastAiMessage.textContent || '').trim();
            const hasReactions = !!lastAiMessage.querySelector('[data-testid="message-item-reactions"]');
            if (text.length > 0 && !hasReactions) {
                return { isTyping: true, provider: 'copilot' };
            }
        }

        return { isTyping: false };
    `,
    metaai: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'metaai' };
        }

        const stopButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find((element) => isVisible(element) && /\bstop\b/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.innerText || element.textContent || '')));
        if (stopButton) {
            return { isTyping: true, provider: 'metaai' };
        }

        const loadingIndicators = Array.from(document.querySelectorAll(
            '[class*="loading"], [class*="typing"], [class*="stream"], [class*="animate"], [aria-busy="true"]'
        )).some((element) => isVisible(element) && !element.closest('nav, header, [role="navigation"]'));

        if (loadingIndicators) {
            return { isTyping: true, provider: 'metaai' };
        }

        return { isTyping: false };
    `,
    qwen: `
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
        };

        if (window.__proxima_is_streaming) {
            return { isTyping: true, provider: 'qwen' };
        }

        const stopButton = Array.from(document.querySelectorAll('button.stop-button, button, [role="button"]'))
            .find((element) => isVisible(element) && (
                String(element.className || '').includes('stop-button') ||
                /stop|cancel/i.test((element.getAttribute('aria-label') || '') + ' ' + (element.innerText || element.textContent || ''))
            ));
        if (stopButton) {
            return { isTyping: true, provider: 'qwen' };
        }

        const assistantMessages = Array.from(document.querySelectorAll('.qwen-chat-message-assistant'));
        const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
        const responseBlock = lastAssistantMessage?.querySelector(
            '.response-message-content .custom-qwen-markdown, .response-message-content .qwen-markdown, .response-message-content'
        );
        const responseText = (responseBlock?.innerText || responseBlock?.textContent || '').trim();
        const pendingStatus = lastAssistantMessage?.querySelector(
            '.qwen-chat-status-card-title-animate, .qwen-chat-status-card, .qwen-chat-tool-status-card, .qwen-chat-thinking-tool-status-card-wraper'
        );
        const pendingText = (pendingStatus?.innerText || pendingStatus?.textContent || '').trim();
        const pendingClassName = String(pendingStatus?.className || '');

        const activeThinkingStatus = Array.from(document.querySelectorAll(
            '.qwen-chat-status-card-title-animate, .qwen-chat-status-card, .qwen-chat-tool-status-card, .qwen-chat-thinking-tool-status-card-wraper, [class*="thinking"], [class*="loading"]'
        )).find((element) => {
            if (!isVisible(element)) return false;
            const text = (element.innerText || element.textContent || '').trim();
            const className = String(element.className || '');

            if (/thinking completed/i.test(text) || className.includes('completed')) {
                return false;
            }

            if (className.includes('page-loading')) {
                return !responseText;
            }

            if (className.includes('qwen-thinking-selector') || className.includes('qwen-select-thinking')) {
                return false;
            }

            return /thinking|generating|analyzing|reasoning|searching/i.test(text);
        });

        if (activeThinkingStatus) {
            return { isTyping: true, provider: 'qwen' };
        }

        if ((!responseText || /^thinking\\.{0,3}$/i.test(responseText)) &&
            pendingStatus &&
            isVisible(pendingStatus) &&
            /thinking|generating|analyzing|reasoning|searching/i.test(pendingText) &&
            !/thinking completed/i.test(pendingText) &&
            !pendingClassName.includes('completed')) {
            return { isTyping: true, provider: 'qwen' };
        }

        return { isTyping: false };
    `
};

const SEND_BUTTON_SELECTORS = {
    chatgpt: [
        '[data-testid="send-button"]',
        'button[aria-label*="Send"]'
    ],
    claude: [
        'button[aria-label*="Send"]',
        'button[type="submit"]',
        'button:has(svg)'
    ],
    gemini: [
        'button.send-button',
        'button.submit',
        'button[type="submit"]',
        'button[class*="send-button"]',
        'button[class*="submit"]'
    ],
    deepseek: [
        'textarea[name="search"]'
    ],
    grok: [
        'button[type="submit"][aria-label="Submit"]',
        'button[type="submit"]'
    ],
    zai: [
        '[aria-label="Send Message"] button',
        'button[aria-label*="Send Message"]',
        '[aria-label*="Send Message"]'
    ],
    copilot: [
        'button[data-testid="submit-button"]',
        'button[aria-label*="Submit message"]',
        'button[aria-label*="Submit"]'
    ],
    metaai: [
        '[data-testid="composer-send-button"]',
        'button[type="submit"]'
    ],
    qwen: [
        'button.send-button',
        'button[class*="send-button"]'
    ],
    perplexity: [
        'button[aria-label*="Submit"]',
        'button[type="submit"]'
    ]
};

function getOldResponseCaptureScript(provider) {
    return RESPONSE_CAPTURE_SCRIPTS[provider] || null;
}

function normalizeResponseState(provider, rawValue) {
    if (provider === 'perplexity') {
        return {
            fingerprint: rawValue?.fingerprint || '',
            blockCount: rawValue?.count || 0
        };
    }

    return {
        fingerprint: typeof rawValue === 'string' ? rawValue : '',
        blockCount: 0
    };
}

function buildResponseExtractionScript(provider) {
    const body = RESPONSE_EXTRACTION_BODIES[provider];
    if (!body) return null;

    return `
        (function() {
            ${DOM_TO_MARKDOWN_HELPERS}
            const PROVIDER_ID = ${JSON.stringify(provider)};
            const PROVIDER_MEDIA_ROOT_SELECTORS = ${JSON.stringify(RESPONSE_MEDIA_ROOT_SELECTORS)};
            const PROVIDER_MEDIA_IMAGE_SELECTORS = ${JSON.stringify(RESPONSE_MEDIA_IMAGE_SELECTORS)};
            const HUMAN_VERIFICATION_HINTS = ${JSON.stringify(HUMAN_VERIFICATION_HINTS)};
            ${STRUCTURED_RESPONSE_HELPERS}

            const text = (function() {
                ${body}
            })();
            const normalizedText = typeof text === 'string' ? text.trim() : '';
            const images = collectResponseImages(PROVIDER_ID);

            return {
                text: normalizedText,
                images,
                imageCount: images.length,
                challenge: detectHumanVerification(PROVIDER_ID),
                url: window.location.href
            };
        })()
    `;
}

function buildTypingDetectionScript(provider) {
    const body = TYPING_DETECTION_BODIES[provider];
    if (!body) {
        return `
            (function() {
                return { isTyping: false };
            })()
        `;
    }

    return `
        (function() {
            ${body}
        })()
    `;
}

function buildSendButtonReadyScript(provider) {
    if (provider === 'deepseek') {
        return `
            (function() {
                const isVisible = (element) => {
                    if (!element) return false;
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
                };

                const textarea = document.querySelector('textarea[placeholder*="DeepSeek"]') ||
                    document.querySelector('textarea[name="search"]') ||
                    document.querySelector('textarea');
                const composerRoot = textarea?.parentElement?.parentElement;
                if (!composerRoot) {
                    return false;
                }

                const controls = Array.from(composerRoot.querySelectorAll('[role="button"], button'))
                    .filter(isVisible);
                if (controls.length === 0) {
                    return false;
                }

                const sendButton = controls[controls.length - 1];
                const ariaDisabled = sendButton.getAttribute('aria-disabled');
                const className = String(sendButton.className || '');
                return ariaDisabled !== 'true' && !className.includes('disabled');
            })()
        `;
    }

    const selectors = SEND_BUTTON_SELECTORS[provider] || [];

    return `
        (function() {
            const selectors = ${JSON.stringify(selectors)};
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };
            let foundButton = false;

            for (const selector of selectors) {
                const buttons = Array.from(document.querySelectorAll(selector));
                for (const sendButton of buttons) {
                    foundButton = true;
                    const className = String(sendButton.className || '').toLowerCase();
                    const ariaDisabled = String(sendButton.getAttribute('aria-disabled') || '').toLowerCase();
                    const isDisabled = !!sendButton.disabled ||
                        sendButton.hasAttribute('disabled') ||
                        ariaDisabled === 'true' ||
                        className.includes('disabled');

                    if (!isDisabled && isVisible(sendButton)) {
                        return true;
                    }
                }
            }

            return foundButton ? false : true;
        })()
    `;
}

function buildFileAttachmentCheckScript(extraIndicators = []) {
    const indicators = [...DEFAULT_FILE_ATTACHMENT_INDICATORS, ...extraIndicators];

    return `
        (function() {
            const indicators = ${JSON.stringify(indicators)};
            for (const selector of indicators) {
                if (document.querySelector(selector)) {
                    return true;
                }
            }
            return false;
        })()
    `;
}

function buildFileUploadPreamble({ fileName, fileBase64, fileMimeType }) {
    return `
        const fileName = ${JSON.stringify(fileName)};
        const fileBase64 = ${JSON.stringify(fileBase64)};
        const fileMimeType = ${JSON.stringify(fileMimeType)};

        function base64ToFile(base64, filename, mimeType) {
            const byteCharacters = atob(base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            return new File([blob], filename, { type: mimeType });
        }

        const file = base64ToFile(fileBase64, fileName, fileMimeType);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
    `;
}

function buildFileUploadScript(provider, payload) {
    const preamble = buildFileUploadPreamble(payload);
    const indicators = JSON.stringify(DEFAULT_FILE_ATTACHMENT_INDICATORS);

    if (provider === 'gemini') {
        return `
            (async function() {
                ${preamble}

                const inputArea = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"], textarea');
                if (!inputArea) {
                    return { success: false, error: 'Input area not found', fileAttached: false };
                }

                inputArea.focus();
                inputArea.click();

                const clipboardData = new DataTransfer();
                clipboardData.items.add(file);

                const pasteEvent = new ClipboardEvent('paste', {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: clipboardData
                });

                inputArea.dispatchEvent(pasteEvent);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                inputArea.focus();
                inputArea.click();

                return {
                    success: true,
                    fileName,
                    mimeType: fileMimeType,
                    fileAttached: true,
                    method: 'clipboard-paste'
                };
            })()
        `;
    }

    const attachButtonSelectors = {
        claude: [
            'button[aria-label*="Attach"]',
            'button[aria-label*="attach"]',
            'button[aria-label*="Add"]'
        ],
        chatgpt: [
            'button[aria-label*="Attach"]',
            'button[data-testid*="attach"]'
        ],
        perplexity: [
            'button[aria-label*="Attach"]',
            'button[aria-label*="attach"]',
            'button[aria-label*="Upload"]',
            'button[aria-label*="Add file"]',
            '[data-testid*="attach"]'
        ],
        zai: [
            'button[aria-label*="Upload"]',
            'button[aria-label*="More"]'
        ],
        copilot: [
            'button[aria-label*="Attach files"]',
            'button[aria-label*="Attach"]'
        ],
        metaai: [
            'button[aria-label*="Add attachment"]',
            'button[aria-label*="attachment"]'
        ],
        qwen: [
            '.mode-select-open',
            '.mode-select .ant-dropdown-trigger',
            '.mode-select'
        ]
    }[provider] || [];

    return `
        (async function() {
            ${preamble}

            const attachButtonSelectors = ${JSON.stringify(attachButtonSelectors)};
            let attachButton = null;
            for (const selector of attachButtonSelectors) {
                attachButton = document.querySelector(selector);
                if (attachButton) break;
            }

            if (attachButton) {
                attachButton.click();
                await new Promise((resolve) => setTimeout(resolve, 500));
            }

            let fileInput = document.querySelector('input[type="file"]');
            if (!fileInput) {
                const allInputs = document.querySelectorAll('input[type="file"]');
                fileInput = allInputs[0];
            }

            if (!fileInput) {
                return { success: false, error: 'No file input found', fileAttached: false };
            }

            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));

            await new Promise((resolve) => setTimeout(resolve, 2000));

            const indicators = ${indicators};
            let fileAttached = false;
            for (const selector of indicators) {
                if (document.querySelector(selector)) {
                    fileAttached = true;
                    break;
                }
            }

            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                fileAttached,
                method: 'file-input'
            };
        })()
    `;
}

function getResponseOptions(provider) {
    const slowProviders = new Set(['claude', 'perplexity', 'deepseek', 'grok', 'zai', 'qwen']);
    const mediumProviders = new Set(['copilot', 'metaai']);
    const stableProviders = new Set(['perplexity', 'deepseek', 'grok', 'zai', 'qwen']);

    return {
        maxWaitSeconds: provider === 'claude' ? 600 : 120,
        domSettleDelayMs: slowProviders.has(provider) ? 1500 : mediumProviders.has(provider) ? 1000 : 500,
        stableThreshold: stableProviders.has(provider) ? 5 : mediumProviders.has(provider) ? 4 : 3,
        maxDomPolls: slowProviders.has(provider) ? 60 : mediumProviders.has(provider) ? 50 : 40
    };
}

function hasNewDomResponse({ provider, previousState, currentState }) {
    if (provider === 'perplexity') {
        const previousFingerprint = previousState?.fingerprint || '';
        const previousBlockCount = previousState?.blockCount || 0;
        const currentFingerprint = currentState?.fingerprint || '';
        const currentBlockCount = currentState?.blockCount || 0;

        const blockCountIncreased = previousBlockCount > 0 && currentBlockCount > previousBlockCount;
        const fingerprintChanged = previousFingerprint &&
            currentFingerprint !== previousFingerprint &&
            !previousFingerprint.startsWith(currentFingerprint.substring(0, 100)) &&
            !currentFingerprint.startsWith(previousFingerprint.substring(0, 100));

        if (!previousFingerprint && previousBlockCount === 0) {
            return true;
        }

        return blockCountIncreased || fingerprintChanged;
    }

    if (provider === 'claude') {
        const previousFingerprint = previousState?.fingerprint || '';
        const currentFingerprint = currentState?.fingerprint || '';

        if (!previousFingerprint) {
            return true;
        }

        return !(
            currentFingerprint === previousFingerprint ||
            previousFingerprint.startsWith(currentFingerprint.substring(0, 100)) ||
            currentFingerprint.startsWith(previousFingerprint.substring(0, 100))
        );
    }

    if (provider === 'deepseek' || provider === 'grok' || provider === 'zai' || provider === 'copilot' || provider === 'metaai' || provider === 'qwen') {
        const previousFingerprint = previousState?.fingerprint || '';
        const currentFingerprint = currentState?.fingerprint || '';

        if (!previousFingerprint) {
            return true;
        }

        return !(
            currentFingerprint === previousFingerprint ||
            previousFingerprint.startsWith(currentFingerprint.substring(0, 100)) ||
            currentFingerprint.startsWith(previousFingerprint.substring(0, 100))
        );
    }

    return true;
}

module.exports = {
    DEFAULT_FILE_ATTACHMENT_INDICATORS,
    getOldResponseCaptureScript,
    normalizeResponseState,
    buildResponseExtractionScript,
    buildTypingDetectionScript,
    buildSendButtonReadyScript,
    buildFileAttachmentCheckScript,
    buildFileUploadScript,
    getResponseOptions,
    hasNewDomResponse
};
