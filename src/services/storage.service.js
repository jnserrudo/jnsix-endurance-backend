const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

class StorageService {
  constructor() {
    this.uploadDir = path.join(__dirname, '../../uploads');
    // Asegurarse de que el directorio raíz de uploads existe
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async uploadFile(file, userId) {
    try {
      const fileExt = path.extname(file.originalname);
      const uniqueName = `${uuidv4()}${fileExt}`;
      const relativePath = `${userId}/${uniqueName}`;
      
      const userDir = path.join(this.uploadDir, userId.toString());
      if (!fs.existsSync(userDir)) {
        await fs.promises.mkdir(userDir, { recursive: true });
      }

      const absolutePath = path.join(userDir, uniqueName);
      await fs.promises.writeFile(absolutePath, file.buffer);

      const publicUrl = `/uploads/${relativePath}`;

      return {
        path: relativePath,
        url: publicUrl
      };
    } catch (error) {
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  async deleteFile(filePath) {
    try {
      const absolutePath = path.join(this.uploadDir, filePath);
      if (fs.existsSync(absolutePath)) {
        await fs.promises.unlink(absolutePath);
      }
      return true;
    } catch (error) {
      throw new Error(`File deletion failed: ${error.message}`);
    }
  }

  async getFileUrl(filePath) {
    try {
      return `/uploads/${filePath}`;
    } catch (error) {
      throw new Error(`Failed to get file URL: ${error.message}`);
    }
  }

  async downloadFile(filePath) {
    try {
      const absolutePath = path.join(this.uploadDir, filePath);
      const buffer = await fs.promises.readFile(absolutePath);
      return buffer;
    } catch (error) {
      throw new Error(`File download failed: ${error.message}`);
    }
  }
}

module.exports = new StorageService();
