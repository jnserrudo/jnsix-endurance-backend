const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

class StorageService {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET || 'activity-files';
  }

  async uploadFile(file, userId) {
    try {
      const fileExt = path.extname(file.originalname);
      const fileName = `${userId}/${uuidv4()}${fileExt}`;

      const { data, error } = await this.supabase.storage
        .from(this.bucket)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (error) {
        throw error;
      }

      const { data: urlData } = this.supabase.storage
        .from(this.bucket)
        .getPublicUrl(fileName);

      return {
        path: fileName,
        url: urlData.publicUrl
      };
    } catch (error) {
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  async deleteFile(filePath) {
    try {
      const { error } = await this.supabase.storage
        .from(this.bucket)
        .remove([filePath]);

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      throw new Error(`File deletion failed: ${error.message}`);
    }
  }

  async getFileUrl(filePath) {
    try {
      const { data } = this.supabase.storage
        .from(this.bucket)
        .getPublicUrl(filePath);

      return data.publicUrl;
    } catch (error) {
      throw new Error(`Failed to get file URL: ${error.message}`);
    }
  }

  async downloadFile(filePath) {
    try {
      const { data, error } = await this.supabase.storage
        .from(this.bucket)
        .download(filePath);

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      throw new Error(`File download failed: ${error.message}`);
    }
  }
}

module.exports = new StorageService();
