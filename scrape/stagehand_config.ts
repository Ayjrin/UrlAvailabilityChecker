/**
 * Stagehand configuration for the domain availability checker
 */
import { OPENAI_API_KEY } from './config';

// Define the Stagehand config interface
interface StagehandConfig {
    env: string;
    verbose: number;
    headless: boolean;
    enable_caching?: boolean;
    enableCaching?: boolean;
    model?: string;
    modelName?: string;
    api_key?: string;
    modelClientOptions?: {
        apiKey: string;
    };
    browserbase_session_id?: string;
    browserbaseSessionID?: string;
}

// Stagehand configuration options
export const STAGEHAND_CONFIG: StagehandConfig = {
    env: "BROWSERBASE",  // Use Browserbase for remote browser
    verbose: 1,  // Enable verbose logging
    headless: true,  // Run in headless mode
    enableCaching: true,  // Enable caching for better performance
    modelName: "gpt-4o-mini",  // Use GPT-4o Mini model for AI capabilities
    modelClientOptions: {
        apiKey: OPENAI_API_KEY  // OpenAI API key for Stagehand
    }
};

/**
 * Get Stagehand configuration with optional session ID
 * 
 * @param browserbaseSessionId - Existing Browserbase session ID
 * @returns Stagehand configuration
 */
export function getStagehandConfig(browserbaseSessionId?: string): StagehandConfig {
    const config: StagehandConfig = { ...STAGEHAND_CONFIG };
    
    if (browserbaseSessionId) {
        config.browserbaseSessionID = browserbaseSessionId;
    }
    
    return config;
}
