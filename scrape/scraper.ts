// Domain availability checker using Browserbase and Playwright
// Schema for domain.json:
// {
//     "domain": "domain name",
//     "status": "unavailable" | "available"
// }
import * as fs from 'fs';
import * as path from 'path';
import * as z from 'zod';
import { Browserbase } from '@browserbasehq/sdk';
import { Stagehand, Page } from '@browserbasehq/stagehand';
import { BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID } from './config';
import { getStagehandConfig } from './stagehand_config';

// Interface for domain data
interface DomainEntry {
  domain: string;
  status: 'available' | 'unavailable' | 'unknown' | 'error';
}

// Define Zod schema for domain availability extraction
const domainAvailabilitySchema = z.object({
  availability: z.enum(['available', 'unavailable']).describe('Whether the domain is available for purchase or not')
});

// Initialize Browserbase and Stagehand with stealth mode
const initBrowserbaseAndStagehand = async (): Promise<{ stagehand: Stagehand, sessionId: string }> => {
  console.log('Initializing Browserbase and Stagehand with stealth mode...');
  console.log(`Using Browserbase API Key: ${BROWSERBASE_API_KEY.substring(0, 10)}...`);
  console.log(`Using Browserbase Project ID: ${BROWSERBASE_PROJECT_ID}`);
  
  try {
    // Initialize Browserbase
    const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
    
    // Create a session with stealth mode enabled
    const session = await bb.sessions.create({
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
    
    console.log(`Session created: ${session.id}`);
    console.log(`Session URL: https://browserbase.com/sessions/${session.id}`);
    
    // Initialize Stagehand with the session ID
    const stagehandConfig = getStagehandConfig(session.id);
    console.log('Initializing Stagehand with config:', stagehandConfig);
    
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
    console.log('Stagehand initialized successfully');
    
    return { stagehand, sessionId: session.id };
  } catch (error) {
    console.error('Error initializing Browserbase and Stagehand:', error);
    throw error;
  }
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
        instruction: "Check if this domain is available for purchase on name.com. Available domains will have text like 'is a great choice' and an 'Add to Cart' button. Unavailable domains will have text like 'is taken' or a 'Make Offer' button.",
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
          
          if (lowerPageContent.includes('is a great choice') || lowerPageContent.includes('add to cart')) {
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

// Check domain availability
const checkDomainAvailability = async (
  domain: string, 
  stagehand: Stagehand,
  domainData: DomainEntry[],
  outputFilePath: string
): Promise<DomainEntry> => {
  console.log(`Checking domain: ${domain}`);
  
  try {
    // Check domain availability on Name.com
    const status = await checkDomainAvailabilityName(domain, stagehand);
    
    // Add domain and status to our data
    const domainEntry: DomainEntry = { domain, status };
    domainData.push(domainEntry);
    console.log(`Domain ${domain} final status: ${status}`);
    
    // Save after each check in case of interruptions
    fs.writeFileSync(outputFilePath, JSON.stringify(domainData, null, 4));
    
    return domainEntry;
  } catch (error) {
    console.error(`Error checking domain ${domain}:`, error);
    const domainEntry: DomainEntry = { domain, status: 'error' };
    domainData.push(domainEntry);
    
    // Save after each check in case of interruptions
    fs.writeFileSync(outputFilePath, JSON.stringify(domainData, null, 4));
    
    return domainEntry;
  }
};

// Main function
const run = async (): Promise<void> => {
  let stagehand: Stagehand | null = null;
  
  try {
    // Initialize Browserbase and Stagehand
    const { stagehand: initializedStagehand, sessionId } = await initBrowserbaseAndStagehand();
    stagehand = initializedStagehand;
    
    // Read domains from input file
    // Use absolute paths to ensure we find the files regardless of where the script is run from
    const projectRoot = path.resolve(__dirname, '..', '..');
    const inputFilePath = path.join(projectRoot, 'input', 'domains.txt');
    const outputFilePath = path.join(projectRoot, 'output', 'domain.json');
    
    // Ensure output directory exists
    const outputDir = path.join(projectRoot, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Initialize or load existing domain data
    let domainData: DomainEntry[] = [];
    if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
      try {
        domainData = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
      } catch (e) {
        // If file exists but is not valid JSON, start with empty array
        console.error('Error parsing existing domain data:', e);
        domainData = [];
      }
    }
    
    // Read domains from input file
    if (!fs.existsSync(inputFilePath)) {
      console.error(`Input file not found: ${inputFilePath}`);
      throw new Error(`Input file not found: ${inputFilePath}`);
    }
    
    const domainsText = fs.readFileSync(inputFilePath, 'utf8');
    const domains = domainsText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      // Remove duplicates
      .filter((domain, index, self) => self.indexOf(domain) === index);
    
    if (domains.length === 0) {
      console.warn('No domains found in the input file. Nothing to check.');
      return;
    }
    
    console.log(`Found ${domains.length} domains to check: ${domains.join(', ')}`);
    
    // Process each domain
    for (const domain of domains) {
      await checkDomainAvailability(domain, stagehand, domainData, outputFilePath);
    }
    
    console.log(`All domains checked. Results saved to ${outputFilePath}`);
    console.log(`View the session replay at https://browserbase.com/sessions/${sessionId}`);
    
  } catch (error) {
    console.error('Error in domain checking process:', error);
  } finally {
    // Clean up
    if (stagehand) {
      await stagehand.close();
    }
  }
};

// Run the script
run().catch(console.error);
