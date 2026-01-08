/**
 * PDF text extraction using pdf.js
 * This wrapper makes pdf.js work properly in Chrome extensions
 */

const PDFExtractor = {
  initialized: false,

  /**
   * Initialize pdf.js with the worker
   */
  async init() {
    if (this.initialized) return;
    
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('pdf.js library not loaded');
    }

    // Set the worker source to our local file
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    this.initialized = true;
  },

  /**
   * Extract text from a PDF file
   * @param {File} file - The PDF file to extract text from
   * @returns {Promise<string>} - Extracted text
   */
  async extractText(file) {
    await this.init();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target.result;
          const text = await this.extractFromArrayBuffer(arrayBuffer);
          resolve(text);
        } catch (error) {
          console.error('PDF extraction error:', error);
          reject(error);
        }
      };
      
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  },

  /**
   * Extract text from ArrayBuffer using pdf.js
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<string>}
   */
  async extractFromArrayBuffer(arrayBuffer) {
    try {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      const textParts = [];
      const numPages = pdf.numPages;
      
      console.log(`PDF loaded: ${numPages} pages`);
      
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        // Extract text items and join them
        const pageText = textContent.items
          .map(item => item.str)
          .join(' ');
        
        if (pageText.trim()) {
          textParts.push(pageText);
        }
      }
      
      // Join pages with double newlines
      let fullText = textParts.join('\n\n');
      
      // Clean up the text
      fullText = this.cleanText(fullText);
      
      console.log(`Extracted ${fullText.length} characters from PDF`);
      
      return fullText;
    } catch (error) {
      console.error('pdf.js extraction failed:', error);
      throw new Error('Failed to extract text from PDF: ' + error.message);
    }
  },

  /**
   * Clean up extracted text
   * @param {string} text
   * @returns {string}
   */
  cleanText(text) {
    if (!text) return '';
    
    return text
      // Fix common ligature issues
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl')
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
