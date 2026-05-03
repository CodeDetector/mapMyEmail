const fs = require('fs');
const path = require('path');

const graphTemplate = fs.readFileSync(path.join(__dirname, 'graph_extraction.md'), 'utf-8');
const knowledgeMapTemplate = fs.readFileSync(path.join(__dirname, 'knowledge_map_synthesis.md'), 'utf-8');

const graphExtractionPrompt = (messageText) => {
    return graphTemplate.replace(/{{messageText}}/g, messageText);
};

const knowledgeMapSynthesisPrompt = (employeeName, employeeId, existingMap, newInteractions) => {
    return knowledgeMapTemplate
        .replace(/{{employeeName}}/g, employeeName)
        .replace(/{{employeeId}}/g, employeeId)
        .replace(/{{existingMap}}/g, existingMap || '{}')
        .replace(/{{newInteractions}}/g, newInteractions);
};

module.exports = {
    graphExtractionPrompt,
    knowledgeMapSynthesisPrompt
};
