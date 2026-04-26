const fs = require('fs');
const path = require('path');

const graphTemplate = fs.readFileSync(path.join(__dirname, 'graph_extraction.md'), 'utf-8');

const graphExtractionPrompt = (messageText) => {
    return graphTemplate.replace(/{{messageText}}/g, messageText);
};

module.exports = {
    graphExtractionPrompt
};
