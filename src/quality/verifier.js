// Proxima — Cross-Model Quality Verifier.
// Evaluates response quality across different models for accuracy, completeness, and relevance.


const EVALUATION_PROMPT = `You are a quality evaluator. Your job is to evaluate the following AI response for accuracy and completeness.

ORIGINAL QUERY:
{query}

AI RESPONSE TO EVALUATE:
{response}

Evaluate the response on these criteria and give a score from 1-10 for each:
1. **Accuracy** — Is the information factually correct?
2. **Completeness** — Does it fully answer the question?
3. **Relevance** — Is everything relevant to the query?
4. **Clarity** — Is it well-structured and easy to understand?

Return ONLY a JSON object in this exact format:
{
  "accuracy": <1-10>,
  "completeness": <1-10>,
  "relevance": <1-10>,
  "clarity": <1-10>,
  "overall": <1-10>,
  "issues": "<brief description of any issues found, or 'none'>"
}`;


export class QualityVerifier {
  constructor(options = {}) {
    this.sendToModel = options.sendToModel;
    this.minScore = options.minScore || 6;
    this.evaluatorModel = options.evaluatorModel || 'gemini';
  }

  async verify(query, response, evaluatorModel) {
    const model = evaluatorModel || this.evaluatorModel;
    

    const fills = { '{query}': query, '{response}': response };
    const prompt = EVALUATION_PROMPT.replace(/\{query\}|\{response\}/g, (m) => fills[m]);

    try {
      const evalResponse = await this.sendToModel(model, prompt);
      const scores = this._parseScores(evalResponse);

      return {
        verified: scores.overall >= this.minScore,
        scores,
        evaluator: model,
        recommendation: scores.overall >= 8 ? 'EXCELLENT' :
                        scores.overall >= 6 ? 'ACCEPTABLE' :
                        scores.overall >= 4 ? 'NEEDS_IMPROVEMENT' : 'REJECT',
      };
    } catch (error) {
      return {
        verified: true,
        scores: null,
        evaluator: model,
        error: error.message,
        recommendation: 'VERIFICATION_FAILED',
      };
    }
  }

  async bestOfN(query, models = ['chatgpt', 'claude', 'gemini']) {
    const results = [];

    for (const model of models) {
      try {
        const response = await this.sendToModel(model, query);
        const verification = await this.verify(query, response, 
          models.find(m => m !== model) || this.evaluatorModel
        );
        
        results.push({
          model,
          response,
          ...verification,
        });
      } catch (error) {
        results.push({
          model,
          response: null,
          error: error.message,
          scores: { overall: 0 },
        });
      }
    }

    results.sort((a, b) => (b.scores?.overall || 0) - (a.scores?.overall || 0));
    
    return {
      best: results[0],
      all: results,
      method: `best-of-${models.length}`,
    };
  }


  async factCheck(claim, model) {
    const checkModel = model || this.evaluatorModel;
    const prompt = `Fact-check this claim. Is it accurate? Reply with JSON: {"accurate": true/false, "correction": "..." or null, "confidence": 1-10}\n\nClaim: "${claim}"`;

    try {
      const response = await this.sendToModel(checkModel, prompt);
      return {
        ...this._parseJSON(response),
        checker: checkModel,
      };
    } catch (error) {
      return { accurate: null, error: error.message, checker: checkModel };
    }
  }

  _parseScores(text) {
    try {
      const jsonStr = this._extractJSON(text);
      const parsed = JSON.parse(jsonStr);
      return {
        accuracy: Number(parsed.accuracy) || 5,
        completeness: Number(parsed.completeness) || 5,
        relevance: Number(parsed.relevance) || 5,
        clarity: Number(parsed.clarity) || 5,
        overall: Number(parsed.overall) || 5,
        issues: parsed.issues || 'none',
      };
    } catch {
      return { accuracy: 5, completeness: 5, relevance: 5, clarity: 5, overall: 5, issues: 'parse_error' };
    }
  }


  _extractJSON(text) {
    text = text.trim();
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) return match[1];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return text.slice(start, end + 1);
    }
    return text;
  }

  _parseJSON(text) {
    try {
      return JSON.parse(this._extractJSON(text));
    } catch {
      return { raw: text };
    }
  }
}

export default QualityVerifier;
