# Proxima — Memory Prompts.
# Prompt templates for fact extraction, memory updates, quality evaluation, and task planning.

from datetime import datetime



_FACT_RETRIEVAL_TEMPLATE = """You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts.

Types of Information to Remember:
1. Store Personal Preferences: likes, dislikes, specific preferences
2. Maintain Important Personal Details: names, relationships, important dates
3. Track Plans and Intentions: upcoming events, goals, plans
4. Remember Activity and Service Preferences: dining, travel, hobbies
5. Monitor Health and Wellness Preferences: dietary restrictions, fitness
6. Store Professional Details: job titles, work habits, career goals
7. Miscellaneous Information: favorite books, movies, brands

Examples:
Input: Hi.
Output: {{"facts" : []}}

Input: Hi, I am looking for a restaurant in San Francisco.
Output: {{"facts" : ["Looking for a restaurant in San Francisco"]}}

Input: Yesterday, I had a meeting with John at 3pm. We discussed the new project.
Output: {{"facts" : ["Had a meeting with John at 3pm", "Discussed the new project"]}}

Input: Hi, my name is John. I am a software engineer.
Output: {{"facts" : ["Name is John", "Is a Software engineer"]}}

Return the facts and preferences in a json format as shown above.

Remember:
- Today's date is {today}.
- If you do not find anything relevant, return an empty list for "facts".
- Create the facts based on the user and assistant messages only.
- Detect the language of the user input and record facts in the same language.
- Return response in json with key "facts" and value as list of strings.

Following is a conversation. Extract relevant facts and preferences:
"""


def build_fact_retrieval_prompt(today: str = None) -> str:
    """Build the fact-extraction prompt with the current date computed at call time."""
    if today is None:
        today = datetime.now().strftime("%Y-%m-%d")
    return _FACT_RETRIEVAL_TEMPLATE.format(today=today)


MEMORY_UPDATE_PROMPT = """You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD, (2) UPDATE, (3) DELETE, and (4) NONE.

Compare newly retrieved facts with existing memory. For each new fact, decide:
- ADD: New information not present in memory
- UPDATE: Information that updates existing memory
- DELETE: Information that contradicts existing memory
- NONE: Information already present (no change needed)

Guidelines:
1. ADD: Generate a new ID for new information
2. UPDATE: Keep the same ID, update the text. Keep the fact with most information.
3. DELETE: Mark for removal if contradicted
4. NONE: No change if already present

Return JSON format:
{
    "memory": [
        {
            "id": "<ID>",
            "text": "<Content>",
            "event": "ADD|UPDATE|DELETE|NONE",
            "old_memory": "<Old content if UPDATE>"
        }
    ]
}

Do not return anything except the JSON format.
"""


QUALITY_EVAL_PROMPT = """You are a quality evaluator. Evaluate the AI response for accuracy and completeness.

ORIGINAL QUERY:
{query}

AI RESPONSE:
{response}

Rate 1-10 for each:
1. Accuracy — Is the information factually correct?
2. Completeness — Does it fully answer the question?
3. Relevance — Is everything relevant?
4. Clarity — Is it well-structured?

Return ONLY JSON:
{{
  "accuracy": <1-10>,
  "completeness": <1-10>,
  "relevance": <1-10>,
  "clarity": <1-10>,
  "overall": <1-10>,
  "issues": "<issues or 'none'>"
}}"""


TASK_PLANNING_PROMPT = """You are a Task Execution Planner. Create a step-by-step plan for the following task.

TASK:
{task}

AVAILABLE TOOLS:
{tools}

Create a detailed plan with:
1. Break the task into clear, numbered steps
2. For each step, specify which tool to use (if applicable)
3. Include expected output for each step
4. Note any dependencies between steps

Return the plan as JSON:
{{
  "steps": [
    {{
      "step": 1,
      "description": "...",
      "tool": "tool_name or null",
      "expected_output": "...",
      "depends_on": []
    }}
  ]
}}"""


REACT_PROMPT = """Respond to the human as helpfully and accurately as possible.

{instruction}

You have access to the following tools:

{tools}

Use a json blob to specify a tool by providing an action key (tool name) and an action_input key (tool input).
Valid "action" values: "Final Answer" or {tool_names}

Provide only ONE action per $JSON_BLOB, as shown:

```
{{
  "action": $TOOL_NAME,
  "action_input": $ACTION_INPUT
}}
```

Follow this format:

Question: input question to answer
Thought: consider previous and subsequent steps
Action:
```
$JSON_BLOB
```
Observation: action result
... (repeat Thought/Action/Observation N times)
Thought: I know what to respond
Action:
```
{{
  "action": "Final Answer",
  "action_input": "Final response to human"
}}
```

Begin! Reminder to ALWAYS respond with a valid json blob of a single action.
Question: {query}
Thought:"""
