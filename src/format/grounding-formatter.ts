export interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
}

/**
 * Formats Google's groundingMetadata into a markdown footnote string.
 * Returns an empty string if no valid web chunks are present.
 * 
 * @param metadata - The grounding metadata from the Gemini API response
 * @returns A formatted markdown string with citations, or an empty string
 */
export function formatGroundingFootnotes(metadata?: GroundingMetadata): string {
  if (!metadata || !metadata.groundingChunks || metadata.groundingChunks.length === 0) {
    return '';
  }

  const validChunks = metadata.groundingChunks
    .filter(chunk => chunk.web && chunk.web.uri)
    .map(chunk => chunk.web!);

  if (validChunks.length === 0) {
    return '';
  }

  let footnotes = '\n\n---\n**Search Sources:**\n';
  validChunks.forEach((web, index) => {
    const title = web.title || web.uri;
    footnotes += `${index + 1}. [${title}](${web.uri})\n`;
  });

  return footnotes.trimEnd();
}

export interface ClientGroundingMetadata {
  search_queries: string[];
  sources: Array<{ title: string; uri: string }>;
}

/**
 * Extracts a normalized grounding_metadata object intended for the root of OpenAI/Anthropic API responses.
 */
export function extractClientGroundingMetadata(metadata?: GroundingMetadata): ClientGroundingMetadata | undefined {
  if (!metadata || (!metadata.webSearchQueries?.length && (!metadata.groundingChunks || metadata.groundingChunks.length === 0))) {
    return undefined;
  }
  
  const sources = (metadata.groundingChunks || [])
    .filter(chunk => chunk.web && chunk.web.uri)
    .map(chunk => ({
      title: chunk.web!.title || chunk.web!.uri,
      uri: chunk.web!.uri
    }));

  if (!metadata.webSearchQueries?.length && sources.length === 0) {
    return undefined;
  }

  return {
    search_queries: metadata.webSearchQueries || [],
    sources
  };
}
