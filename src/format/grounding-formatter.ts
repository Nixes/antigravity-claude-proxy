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
