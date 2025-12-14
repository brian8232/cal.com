const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const fs = require('fs').promises;
const path = require('path');

// Initialize clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// File extensions to analyze
const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.html', '.css'];

// Get all code files from a directory
async function getCodeFiles(dir, fileList = []) {
  const files = await fs.readdir(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    
    if (stat.isDirectory()) {
      // Skip common directories
      if (!['node_modules', '.git', 'dist', 'build', 'coverage'].includes(file)) {
        await getCodeFiles(filePath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (CODE_EXTENSIONS.includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  
  return fileList;
}

// Analyze entire feature/module with Claude
async function analyzeFeature(featureName, codeFiles) {
  console.log(`\nAnalyzing ${featureName} feature with ${codeFiles.length} files...`);
  
  // Prepare all code content
  let allCode = '';
  for (const file of codeFiles) {
    const code = await fs.readFile(file.path, 'utf-8');
    allCode += `\n\n--- File: ${file.name} ---\n${code}`;
  }
  
  const prompt = `You are analyzing a complete feature/module from a codebase. Review all the files provided and create comprehensive documentation.

Feature: ${featureName}

Files included:
${codeFiles.map(f => `- ${f.name}`).join('\n')}

Code:
${allCode}

Analyze this feature as a whole and provide detailed documentation in JSON format.

Return ONLY valid JSON (no markdown, no backticks) with this structure:
{
  "featureName": "Clear, descriptive name for this feature",
  "plainEnglish": "Explain what this feature does in simple, non-technical language that anyone could understand (3-4 sentences)",
  "description": "What this feature does and its purpose from a technical perspective (2-3 short paragraphs, separated by \\n\\n)",
  "howItWorks": "High-level explanation of the architecture and flow. Break into 3-4 short paragraphs, separated by \\n\\n. Each paragraph should focus on one aspect.",
  "technicalDetails": "Key implementation details. Format as bullet points using this exact format: • Point one\\n• Point two\\n• Point three (7-10 bullet points)",
  "errorHandling": "Array of error objects with this structure: [{errorMessage: 'exact error string', explanation: 'what causes it and how to resolve'}]. Include 5-8 common errors.",
  "flowchart": "Mermaid flowchart code showing the main user flow and logic. Use 'graph TD' format with clear steps."
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const responseText = message.content[0].text;
  
  // Clean up response
  const cleanedResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  
  try {
    return JSON.parse(cleanedResponse);
  } catch (e) {
    console.error(`Failed to parse JSON:`, e);
    console.error('Response:', cleanedResponse);
    throw e;
  }
}

// Create Notion page with content in body
async function createNotionPage(featureData, filePaths) {
  const { featureName, plainEnglish, description, howItWorks, technicalDetails, errorHandling, flowchart } = featureData;
  
  try {
    // Check if page already exists
    const existingPages = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Name',
        title: {
          equals: featureName
        }
      }
    });

    // Generate Mermaid chart URL
    const mermaidImageUrl = `https://mermaid.ink/img/${Buffer.from(flowchart).toString('base64')}`;

    // Helper function to create paragraphs from text with \n\n separators
    const createParagraphs = (text) => {
      return text.split('\n\n').map(para => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: para.trim() } }]
        }
      }));
    };

    // Helper function to create bullet points from text with \n separators
    const createBulletList = (text) => {
      return text.split('\n').filter(line => line.trim()).map(item => ({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: item.replace(/^[•\-]\s*/, '').trim() } }]
        }
      }));
    };

    // Helper function to create error blocks
    const createErrorBlocks = (errors) => {
      return errors.map(error => ({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { 
              type: 'text', 
              text: { content: error.errorMessage },
              annotations: { code: true }
            },
            {
              type: 'text',
              text: { content: ' - ' }
            },
            {
              type: 'text',
              text: { content: error.explanation }
            }
          ]
        }
      }));
    };

    // Create page content blocks
    const contentBlocks = [
      {
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: featureName } }]
        }
      },
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '💡 What This Does (Plain English)' } }]
        }
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: plainEnglish } }],
          icon: { emoji: '💡' }
        }
      },
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '📋 Description' } }]
        }
      },
      ...createParagraphs(description),
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '⚙️ How It Works' } }]
        }
      },
      ...createParagraphs(howItWorks),
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '🔧 Technical Details' } }]
        }
      },
      ...createBulletList(technicalDetails),
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '⚠️ Error Handling' } }]
        }
      },
      ...createErrorBlocks(errorHandling),
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: '📊 Visual Flowchart' } }]
        }
      },
      {
        object: 'block',
        type: 'image',
        image: {
          type: 'external',
          external: {
            url: mermaidImageUrl
          }
        }
      },
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: 'View Mermaid Code' } }],
          children: [
            {
              object: 'block',
              type: 'code',
              code: {
                rich_text: [{ type: 'text', text: { content: flowchart } }],
                language: 'mermaid'
              }
            }
          ]
        }
      }
    ];

    let pageId;
    if (existingPages.results.length > 0) {
      // Update existing page - delete old blocks and add new ones
      pageId = existingPages.results[0].id;
      
      // Update properties
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Name': {
            title: [{ text: { content: featureName } }]
          },
          'Last Updated': {
            date: { start: new Date().toISOString() }
          },
          'File Path': {
            rich_text: [{ text: { content: filePaths } }]
          }
        }
      });
      
      // Get existing blocks and delete them
      const existingBlocks = await notion.blocks.children.list({
        block_id: pageId
      });
      
      for (const block of existingBlocks.results) {
        await notion.blocks.delete({ block_id: block.id });
      }
      
      console.log(`✓ Updated: ${featureName}`);
    } else {
      // Create new page
      const newPage = await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: {
          'Name': {
            title: [{ text: { content: featureName } }]
          },
          'Last Updated': {
            date: { start: new Date().toISOString() }
          },
          'File Path': {
            rich_text: [{ text: { content: filePaths } }]
          }
        }
      });
      pageId = newPage.id;
      console.log(`✓ Created: ${featureName}`);
    }

    // Add all content blocks
    await notion.blocks.children.append({
      block_id: pageId,
      children: contentBlocks
    });
    
    console.log(`  ✓ Added formatted content to page`);
  } catch (error) {
    console.error(`Error creating/updating Notion page for ${featureName}:`, error);
    throw error;
  }
}

// Main function
async function main() {
  try {
    // Target the Backbone example specifically
    const featurePath = './examples/backbone';
    
    console.log(`Scanning Backbone TodoMVC at: ${featurePath}`);
    
    // Get all code files
    const codeFiles = await getCodeFiles(featurePath);
    console.log(`Found ${codeFiles.length} code files`);
    
    // Prepare file info
    const fileInfo = codeFiles.map(filePath => ({
      path: filePath,
      name: path.relative(featurePath, filePath)
    }));
    
    // Analyze the entire feature as one unit
    const analysis = await analyzeFeature('Backbone TodoMVC', fileInfo);
    
    // Create the Notion page
    const filePaths = fileInfo.map(f => f.name).join(', ');
    await createNotionPage(analysis, filePaths);
    
    console.log('\n✓ Documentation generation complete!');
    console.log(`📊 Cost estimate: ~$0.50-1.00 for this feature`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
