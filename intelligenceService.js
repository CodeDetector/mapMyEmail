const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { graphExtractionPrompt } = require('./prompts');
const supabaseService = require('./supabaseService');

class IntelligenceService {
    constructor() {
        this.genAI = null;
        if (config.GEMINI_API_KEY) {
            this.genAI = new GoogleGenAI(config.GEMINI_API_KEY);
        }
    }

    async processMessageForGraph(messageText, messageMetadata = {}) {
        if (!this.genAI) return;

        try {
            const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
            const prompt = graphExtractionPrompt(messageText);
            
            const result = await client.models.generateContent({
                model: 'gemma-4-31b-it',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            
            const responseText = result.text.replace(/```json|```/g, '').trim();
            
            let graphData;
            try {
                graphData = JSON.parse(responseText);
            } catch (jsonErr) {
                return;
            }

            await this.ingestGraphData(graphData, messageMetadata.messageId);
        } catch (err) {
            console.error('❌ IntelligenceService error:', err.message);
        }
    }

    async ingestGraphData(graphData, sourceId) {
        const { nodes = [], edges = [] } = graphData;
        const nodeMap = {}; 

        for (const node of nodes) {
            try {
                const nodeId = await supabaseService.upsertNode(node.type, node.name, {
                    ...node.properties,
                    lastMentionedIn: sourceId
                });
                if (nodeId) nodeMap[node.name] = nodeId;
            } catch (e) {}
        }

        for (const edge of edges) {
            try {
                const fromId = nodeMap[edge.from];
                const toId = nodeMap[edge.to];
                if (fromId && toId) {
                    await supabaseService.createEdge(fromId, toId, edge.type, {
                        ...edge.properties,
                        sourceId: sourceId,
                        timestamp: new Date()
                    });
                }
            } catch (e) {}
        }
    }
}

module.exports = new IntelligenceService();
