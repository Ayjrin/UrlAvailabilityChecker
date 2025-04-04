// Domain availability checker using Browserbase and Playwright
// Schema for domain.json:
// {
//     "domain": "domain name",
//     "status": "unavailable" | "available"
// }
import * as fs from 'fs';
import * as path from 'path';
import { Browserbase } from '@browserbasehq/sdk';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, OPENAI_API_KEY } from './config';
import { getStagehandConfig } from './stagehand_config';

// Define the structure of a domain entry
interface DomainEntry {
  domain: string;
  status: 'available' | 'unavailable' | 'unknown' | 'error';
}

// Initialize Browserbase and Stagehand with stealth mode
const initializeBrowserbaseSession = async (sessionNumber: number): Promise<Stagehand> => {
  console.log(`Initializing Browserbase and Stagehand session ${sessionNumber} with stealth mode...`);
  
  // Create a new Browserbase instance
  const browserbase = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
  
  // Create a new session
  const session = await browserbase.sessions.create({
    projectId: BROWSERBASE_PROJECT_ID,
    browserSettings: {
      // Configure stealth options to avoid bot detection
      fingerprint: {
        browsers: ["chrome"],
        devices: ["desktop"],
        locales: ["en-US"],
        operatingSystems: ["windows"],
        screen: {
          maxWidth: 1920,
          maxHeight: 1080,
          minWidth: 1024,
          minHeight: 768,
        }
      },
      viewport: {
        width: 1920,
        height: 1080,
      },
      solveCaptchas: true,
    },
    proxies: true, // Use proxies to avoid IP-based blocking
  });
  
  console.log(`Session ${sessionNumber} created: ${session.id}`);
  console.log(`Session ${sessionNumber} URL: https://browserbase.com/sessions/${session.id}`);
  
  // Configure Stagehand
  const stagehandConfig = getStagehandConfig(session.id);
  console.log(`Initializing Stagehand session ${sessionNumber} with config:`, stagehandConfig);
  
  // Create a new Stagehand instance
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: BROWSERBASE_API_KEY,
    projectId: BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: session.id,
    modelName: stagehandConfig.modelName as "gpt-4o-mini", 
    modelClientOptions: stagehandConfig.modelClientOptions,
    enableCaching: stagehandConfig.enableCaching,
    verbose: stagehandConfig.verbose as 0
  });
  
  // Initialize Stagehand
  await stagehand.init();
  console.log(`Stagehand session ${sessionNumber} initialized successfully`);
  
  return stagehand;
};

// Check domain availability using Name.com
const checkDomainAvailabilityName = async (
  domain: string, 
  stagehand: Stagehand,
  retryCount = 0
): Promise<DomainEntry['status']> => {
  try {
    console.log(`Checking domain on Name.com: ${domain} (attempt ${retryCount + 1})`);
    
    // Add a delay between requests to avoid rate limiting
    if (retryCount > 0) {
      const delayMs = 5000 * retryCount; // Increase delay with each retry
      console.log(`Waiting for ${delayMs}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    try {
      // Clear cookies before each navigation to start fresh
      await stagehand.page.context().clearCookies();
      
      // Format domain for URL - remove protocol and www if present
      const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
      
      // Navigate directly to the domain search results page
      const searchUrl = `https://www.name.com/domain/search/${cleanDomain}`;
      console.log(`Navigating to: ${searchUrl}`);
      
      // Use shorter timeouts to avoid long waits
      await stagehand.page.goto(searchUrl, { timeout: 30000 });
      
      // Wait for DOM content to load instead of network idle
      await stagehand.page.waitForLoadState('domcontentloaded', { timeout: 30000 });
      
      // Use extract() with a simpler schema for more reliable results
      console.log(`Using extract() to determine domain availability for ${domain}`);
      
      const domainAvailabilitySchema = z.object({
        isAvailable: z.boolean().describe("Is the domain available for purchase? Look for 'Add to Cart' button or text like 'is a great choice'"),
        statusText: z.string().describe("The exact text shown that indicates domain availability status")
      });
      
      const extractResult = await stagehand.page.extract({
        instruction: "Determine if this domain is available for purchase on name.com. IMPORTANT: A domain is AVAILABLE only if it shows 'Add To Cart' button AND text saying it 'is a great choice'. A domain is UNAVAILABLE if it shows 'Make Offer' button OR text saying it 'is taken'. Look carefully at the entire page for these specific elements before deciding.",
        schema: domainAvailabilitySchema,
        useTextExtract: true
      });
      
      console.log(`Extract result for ${domain}:`, extractResult);
      
      if (extractResult.isAvailable) {
        console.log(`Domain ${domain} is AVAILABLE based on extract result`);
        return 'available';
      } else {
        console.log(`Domain ${domain} is UNAVAILABLE based on extract result`);
        return 'unavailable';
      }
      
    } catch (navigationError) {
      console.error(`Navigation error for ${domain}:`, navigationError);
      
      // If we've already retried a few times, try a different approach
      if (retryCount >= 2) {
        console.log(`Multiple navigation errors, trying alternative approach for ${domain}...`);
        
        try {
          // Try going to the homepage first
          await stagehand.page.goto('https://www.name.com/', { timeout: 30000 });
          await stagehand.page.waitForLoadState('domcontentloaded', { timeout: 30000 });
          
          // Try using the search box via act()
          console.log(`Using act() to search for domain: ${domain}`);
          await stagehand.page.act({
            action: `Type the domain name %domain% into the search box and search for it`,
            variables: {
              domain: domain
            }
          });
          
          // Wait for results
          await stagehand.page.waitForLoadState('domcontentloaded', { timeout: 30000 });
          
          // Check page content directly
          const pageContent = await stagehand.page.content();
          const lowerPageContent = pageContent.toLowerCase();
          
          if (lowerPageContent.includes('is a great choice') && lowerPageContent.includes('add to cart')) {
            return 'available';
          }
          
          if (lowerPageContent.includes('is taken') || lowerPageContent.includes('make offer')) {
            return 'unavailable';
          }
          
          return 'unknown';
          
        } catch (altError) {
          console.error(`Alternative approach failed for ${domain}:`, altError);
          throw altError;
        }
      }
      
      // Otherwise, retry with a delay
      console.log(`Retrying with delay for ${domain}...`);
      
      // Recursive retry with incremented retry count
      return checkDomainAvailabilityName(domain, stagehand, retryCount + 1);
    }
    
  } catch (error) {
    console.error(`Error checking domain ${domain}:`, error);
    return 'error';
  }
};

// Generic domain availability checker
const checkDomainAvailability = async (domain: string, stagehand: Stagehand): Promise<DomainEntry['status']> => {
  try {
    // Check domain availability on Name.com
    return await checkDomainAvailabilityName(domain, stagehand);
  } catch (error) {
    console.error(`Error checking domain ${domain}:`, error);
    return 'error';
  }
};

// Safely read the results file with retries
const safelyReadResultsFile = async (filePath: string, maxRetries = 3): Promise<DomainEntry[]> => {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`Results file does not exist yet at ${filePath}, creating empty array`);
        
        // Ensure the directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          console.log(`Created directory: ${dir}`);
        }
        
        // Create an empty file
        fs.writeFileSync(filePath, JSON.stringify([], null, 4));
        return [];
      }
      
      // Read the file
      const data = fs.readFileSync(filePath, 'utf-8');
      
      // Handle empty file case
      if (!data.trim()) {
        console.log(`Results file at ${filePath} is empty, returning empty array`);
        return [];
      }
      
      try {
        // Parse the JSON
        const results = JSON.parse(data) as DomainEntry[];
        console.log(`Successfully read ${results.length} entries from ${filePath}`);
        return results;
      } catch (parseError) {
        console.error(`Error parsing JSON from ${filePath}:`, parseError);
        
        // If the file is corrupted, create a backup and return empty array
        const backupPath = `${filePath}.backup.${Date.now()}`;
        fs.copyFileSync(filePath, backupPath);
        console.log(`Created backup of corrupted file at ${backupPath}`);
        
        // Create a new empty file
        fs.writeFileSync(filePath, JSON.stringify([], null, 4));
        return [];
      }
    } catch (error) {
      retries++;
      console.error(`Error reading results file (attempt ${retries}/${maxRetries}):`, error);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.error(`Failed to read results file after ${maxRetries} attempts`);
  return [];
};

// Safely write to the results file with retries
const safelyWriteResultsFile = async (
  filePath: string, 
  data: DomainEntry[], 
  maxRetries = 3
): Promise<boolean> => {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      // Ensure the directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory for results: ${dir}`);
      }
      
      // Create a backup of the existing file if it exists
      if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.backup`;
        fs.copyFileSync(filePath, backupPath);
        console.log(`Created backup of existing results at ${backupPath}`);
      }
      
      // Write to a temporary file first
      const tempFilePath = `${filePath}.tmp`;
      fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 4));
      console.log(`Wrote ${data.length} entries to temporary file ${tempFilePath}`);
      
      // Rename the temporary file to the actual file (atomic operation)
      fs.renameSync(tempFilePath, filePath);
      console.log(`Successfully renamed temporary file to ${filePath}`);
      
      return true;
    } catch (error) {
      retries++;
      console.error(`Error writing results file (attempt ${retries}/${maxRetries}):`, error);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
  
  console.error(`Failed to write results file after ${maxRetries} attempts`);
  return false;
};

// Process a batch of domains with a specific session
const processDomainBatch = async (
  domains: string[], 
  sessionNumber: number,
  outputPath: string
): Promise<void> => {
  let stagehand: Stagehand | null = null;
  
  try {
    // Initialize the session
    stagehand = await initializeBrowserbaseSession(sessionNumber);
    console.log(`Stagehand session ${sessionNumber} initialized successfully`);
    
    // Read the current results once at the start to get a baseline
    let currentResults = await safelyReadResultsFile(outputPath);
    let checkedDomainsSet = new Set(currentResults.map(entry => entry.domain));
    
    console.log(`Session ${sessionNumber}: Starting with ${checkedDomainsSet.size} already checked domains`);
    
    // Process each domain in the batch
    for (const domain of domains) {
      try {
        // Skip if domain has already been checked (double-check in case another session added it)
        if (checkedDomainsSet.has(domain)) {
          console.log(`Session ${sessionNumber}: Domain ${domain} already checked, skipping...`);
          continue;
        }
        
        console.log(`Session ${sessionNumber} checking domain: ${domain}`);
        const status = await checkDomainAvailability(domain, stagehand);
        
        // Create a new entry 
        const newEntry: DomainEntry = {
          domain,
          status,
        };
        
        // Read the latest results again (they might have changed)
        currentResults = await safelyReadResultsFile(outputPath);
        checkedDomainsSet = new Set(currentResults.map(entry => entry.domain));
        
        // Check again if the domain has been processed while we were checking
        if (!checkedDomainsSet.has(domain)) {
          // Add the new entry
          currentResults.push(newEntry);
          
          // Save the updated results
          await safelyWriteResultsFile(outputPath, currentResults);
          console.log(`Session ${sessionNumber}: Results for ${domain} saved to ${outputPath}`);
          
          // Update our local set
          checkedDomainsSet.add(domain);
        } else {
          console.log(`Session ${sessionNumber}: Domain ${domain} was checked by another session while processing, skipping save`);
        }
      } catch (domainError) {
        console.error(`Session ${sessionNumber}: Error processing domain ${domain}:`, domainError);
        
        // Try to save the error status
        try {
          currentResults = await safelyReadResultsFile(outputPath);
          checkedDomainsSet = new Set(currentResults.map(entry => entry.domain));
          
          // Only add if not already present
          if (!checkedDomainsSet.has(domain)) {
            currentResults.push({
              domain,
              status: 'error',
            });
            
            await safelyWriteResultsFile(outputPath, currentResults);
            checkedDomainsSet.add(domain);
          }
        } catch (saveError) {
          console.error(`Session ${sessionNumber}: Failed to save error status for ${domain}:`, saveError);
        }
      }
    }
  } catch (sessionError) {
    console.error(`Error in session ${sessionNumber}:`, sessionError);
  } finally {
    // Clean up the session
    if (stagehand) {
      try {
        await stagehand.close();
        console.log(`Session ${sessionNumber} closed successfully`);
      } catch (closeError) {
        console.error(`Error closing session ${sessionNumber}:`, closeError);
      }
    }
  }
};

// Main function
const run = async () => {
  try {
    // Get the project root directory
    const projectRoot = path.resolve(__dirname, '..');
    console.log(`Project root: ${projectRoot}`);
    
    // Define input and output paths
    const inputDir = path.join(projectRoot, 'input');
    const outputDir = path.join(projectRoot, 'output');
    
    // Ensure directories exist
    if (!fs.existsSync(inputDir)) {
      console.log(`Creating input directory: ${inputDir}`);
      fs.mkdirSync(inputDir, { recursive: true });
    }
    
    if (!fs.existsSync(outputDir)) {
      console.log(`Creating output directory: ${outputDir}`);
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const domainsPath = path.join(inputDir, 'domains.txt');
    const outputPath = path.join(outputDir, 'domain.json');
    
    console.log(`Domains path: ${domainsPath}`);
    console.log(`Output path: ${outputPath}`);
    
    // Read domains from file
    if (!fs.existsSync(domainsPath)) {
      console.log(`Domains file not found: ${domainsPath}`);
      return;
    }
    
    const domainsContent = fs.readFileSync(domainsPath, 'utf-8');
    const domains = domainsContent.split('\n').map(d => d.trim()).filter(Boolean);
    
    if (domains.length === 0) {
      console.log('No domains found in the input file');
      return;
    }
    
    // Remove duplicates
    const uniqueDomains = [...new Set(domains)];
    console.log(`Found ${uniqueDomains.length} unique domains in input file`);
    
    // Read existing results
    const existingResults = await safelyReadResultsFile(outputPath);
    console.log(`Successfully read ${existingResults.length} entries from ${outputPath}`);
    
    // Filter out domains with error status so they can be retried
    const validResults = existingResults.filter(entry => entry.status !== 'error');
    
    if (validResults.length < existingResults.length) {
      console.log(`Removed ${existingResults.length - validResults.length} domains with error status for retry`);
      
      // Save the filtered results back to the file
      await safelyWriteResultsFile(outputPath, validResults);
      console.log(`Updated results file with ${validResults.length} valid entries`);
    }
    
    // Create a Set of already checked domains for O(1) lookup
    const checkedDomainsSet = new Set(validResults.map(entry => entry.domain));
    console.log(`${checkedDomainsSet.size} domains have already been checked`);
    
    // Filter out domains that have already been checked
    const domainsToCheck = uniqueDomains.filter(domain => !checkedDomainsSet.has(domain));
    
    console.log(`${domainsToCheck.length} domains need to be checked`);
    if (domainsToCheck.length === 0) {
      console.log('All domains have already been checked. Nothing to do.');
      return;
    }
    
    // Determine how many sessions to use (up to 3)
    const numberOfSessions = Math.min(3, domainsToCheck.length);
    console.log(`Using ${numberOfSessions} parallel sessions`);
    
    // Distribute domains evenly across sessions
    const domainBatches: string[][] = Array.from({ length: numberOfSessions }, () => []);
    
    domainsToCheck.forEach((domain, index) => {
      const sessionIndex = index % numberOfSessions;
      domainBatches[sessionIndex].push(domain);
    });
    
    // Log the distribution
    domainBatches.forEach((batch, index) => {
      console.log(`Session ${index + 1} will check ${batch.length} domains`);
    });
    
    // Process all batches in parallel
    await Promise.all(
      domainBatches.map((batch, index) => 
        processDomainBatch(batch, index + 1, outputPath)
      )
    );
    
    console.log('All domains have been checked');
    
  } catch (error) {
    console.error('Error in main function:', error);
  }
};

// Run the main function
run().catch(error => {
  console.error('Unhandled error in main function:', error);
  process.exit(1);
});
