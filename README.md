# Domain Availability Checker

A TypeScript application that checks domain availability using Name.com. This tool uses AI-powered browser automation to determine if domains are available for registration.

## Features

- Check domain availability on Name.com
- AI-powered browser automation using Stagehand and Browserbase
- Robust error handling with retry logic
- Structured data extraction using Zod schemas
- TypeScript implementation for type safety

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Set up configuration:
   - Copy `scrape/config.template.ts` to `scrape/config.ts`
   - Add your Browserbase API key and project ID
   - Add your OpenAI API key

## Usage

1. Add domains to check in `input/domains.txt` (one domain per line)
2. Run the checker:
   ```
   npm run build
   node dist/scrape/scraper.js
   ```
3. Check results in `output/domain.json`

## Technologies Used

- TypeScript
- Playwright
- Browserbase
- Stagehand
- Zod

## Project Structure

- `/scrape`: Contains the main scraper code
  - `scraper.ts`: Main domain checking logic
  - `stagehand_config.ts`: Configuration for Stagehand
  - `config.template.ts`: Template for API keys (copy to config.ts)
- `/input`: Input files
  - `domains.txt`: List of domains to check
- `/output`: Output files
  - `domain.json`: Results of domain checks

## License

MIT
