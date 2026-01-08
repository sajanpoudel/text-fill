/**
 * Simple PDF text extraction for Chrome extensions
 * Uses basic PDF parsing without external dependencies
 */

const PDFExtractor = {
  /**
   * Extract text from a PDF file
   * @param {File} file - The PDF file to extract text from
   * @returns {Promise<string>} - Extracted text
   */
  async extractText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target.result;
          const text = await this.parseArrayBuffer(arrayBuffer);
          resolve(text);
        } catch (error) {
          reject(error);
        }
      };
      
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  },

  /**
   * Parse PDF from ArrayBuffer
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<string>}
   */
  async parseArrayBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const text = this.extractTextFromPDF(bytes);
    return text;
  },

  /**
   * Extract text content from PDF bytes
   * This is a basic implementation that handles common PDF structures
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  extractTextFromPDF(bytes) {
    // Convert to string for parsing
    let pdfString = '';
    for (let i = 0; i < bytes.length; i++) {
      pdfString += String.fromCharCode(bytes[i]);
    }

    const textParts = [];
    
    // Method 1: Extract text from stream objects (most common)
    const streamRegex = /stream\s*([\s\S]*?)\s*endstream/g;
    let match;
    
    while ((match = streamRegex.exec(pdfString)) !== null) {
      const streamContent = match[1];
      const extracted = this.extractTextFromStream(streamContent);
      if (extracted) {
        textParts.push(extracted);
      }
    }

    // Method 2: Extract text from BT/ET blocks (text objects)
    const textObjectRegex = /BT\s*([\s\S]*?)\s*ET/g;
    
    while ((match = textObjectRegex.exec(pdfString)) !== null) {
      const textBlock = match[1];
      const extracted = this.extractTextFromTextObject(textBlock);
      if (extracted) {
        textParts.push(extracted);
      }
    }

    // Method 3: Look for plain text patterns
    const plainTextRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    const allMatches = pdfString.match(plainTextRegex) || [];
    
    for (const textMatch of allMatches) {
      const cleaned = textMatch.slice(1, -1); // Remove parentheses
      const decoded = this.decodePDFString(cleaned);
      if (decoded && decoded.length > 2 && this.isReadableText(decoded)) {
        textParts.push(decoded);
      }
    }

    // Combine and clean up
    let result = textParts.join(' ');
    result = this.cleanText(result);
    
    return result;
  },

  /**
   * Extract text from a PDF stream
   * @param {string} stream
   * @returns {string}
   */
  extractTextFromStream(stream) {
    const textParts = [];
    
    // Look for Tj and TJ operators (show text)
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    const tjArrayRegex = /\[(.*?)\]\s*TJ/g;
    
    let match;
    
    while ((match = tjRegex.exec(stream)) !== null) {
      const text = this.decodePDFString(match[1]);
      if (text) textParts.push(text);
    }
    
    while ((match = tjArrayRegex.exec(stream)) !== null) {
      const arrayContent = match[1];
      const stringRegex = /\(([^)]*)\)/g;
      let strMatch;
      while ((strMatch = stringRegex.exec(arrayContent)) !== null) {
        const text = this.decodePDFString(strMatch[1]);
        if (text) textParts.push(text);
      }
    }
    
    return textParts.join('');
  },

  /**
   * Extract text from BT/ET text object
   * @param {string} textObject
   * @returns {string}
   */
  extractTextFromTextObject(textObject) {
    const textParts = [];
    const stringRegex = /\(([^)]*)\)/g;
    
    let match;
    while ((match = stringRegex.exec(textObject)) !== null) {
      const text = this.decodePDFString(match[1]);
      if (text) textParts.push(text);
    }
    
    return textParts.join(' ');
  },

  /**
   * Decode PDF string escapes
   * @param {string} str
   * @returns {string}
   */
  decodePDFString(str) {
    if (!str) return '';
    
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\\(\d{1,3})/g, (match, octal) => {
        return String.fromCharCode(parseInt(octal, 8));
      });
  },

  /**
   * Check if text is readable (not binary garbage)
   * @param {string} text
   * @returns {boolean}
   */
  isReadableText(text) {
    if (!text || text.length < 2) return false;
    
    // Count printable characters
    let printable = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if ((code >= 32 && code <= 126) || code === 10 || code === 13 || code === 9) {
        printable++;
      }
    }
    
    // At least 70% should be printable
    return (printable / text.length) > 0.7;
  },

  /**
   * Clean up extracted text
   * @param {string} text
   * @returns {string}
   */
  cleanText(text) {
    if (!text) return '';
    
    return text
      // Remove null characters
      .replace(/\x00/g, '')
      // Normalize whitespace
      .replace(/[\r\n]+/g, '\n')
      .replace(/[ \t]+/g, ' ')
      // Remove lines that are just whitespace
      .replace(/\n\s+\n/g, '\n\n')
      // Remove excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      // Trim
      .trim();
  }
};

// Make available globally
window.PDFExtractor = PDFExtractor;
