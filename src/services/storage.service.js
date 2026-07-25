const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

function s3Configured() {
  return Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY &&
      process.env.S3_SECRET_KEY
  );
}

class StorageService {
  constructor() {
    this.uploadDir = path.join(__dirname, '../../uploads');
    this.useS3 = s3Configured();
    this.s3Client = null;
    this.bucket = process.env.S3_BUCKET || null;
    this.publicBase =
      process.env.S3_PUBLIC_URL ||
      (this.useS3 ? `${process.env.S3_ENDPOINT.replace(/\/$/, '')}/${this.bucket}` : null);

    if (!this.useS3 && !fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    if (this.useS3) {
      // Lazy-require so local-only installs without AWS SDK still boot if misconfigured later
      const { S3Client } = require('@aws-sdk/client-s3');
      this.s3Client = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        },
      });
      console.log(`[Storage] S3-compatible mode → bucket=${this.bucket}`);
    } else {
      console.log('[Storage] Local uploads/ mode');
    }
  }

  _objectKey(userId, uniqueName) {
    return `${userId}/${uniqueName}`;
  }

  _publicUrl(relativePath) {
    if (this.useS3) {
      return `${this.publicBase.replace(/\/$/, '')}/${relativePath}`;
    }
    return `/uploads/${relativePath}`;
  }

  async uploadFile(file, userId) {
    try {
      const fileExt = path.extname(file.originalname);
      const uniqueName = `${uuidv4()}${fileExt}`;
      const relativePath = this._objectKey(userId, uniqueName);

      if (this.useS3) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: relativePath,
            Body: file.buffer,
            ContentType: file.mimetype || 'application/octet-stream',
          })
        );
      } else {
        const userDir = path.join(this.uploadDir, userId.toString());
        if (!fs.existsSync(userDir)) {
          await fs.promises.mkdir(userDir, { recursive: true });
        }
        const absolutePath = path.join(userDir, uniqueName);
        await fs.promises.writeFile(absolutePath, file.buffer);
      }

      return {
        path: relativePath,
        url: this._publicUrl(relativePath),
      };
    } catch (error) {
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  async deleteFile(filePath) {
    try {
      if (this.useS3) {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: filePath,
          })
        );
      } else {
        const absolutePath = path.join(this.uploadDir, filePath);
        if (fs.existsSync(absolutePath)) {
          await fs.promises.unlink(absolutePath);
        }
      }
      return true;
    } catch (error) {
      throw new Error(`File deletion failed: ${error.message}`);
    }
  }

  async getFileUrl(filePath) {
    try {
      return this._publicUrl(filePath);
    } catch (error) {
      throw new Error(`Failed to get file URL: ${error.message}`);
    }
  }

  async downloadFile(filePath) {
    try {
      if (this.useS3) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const res = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: filePath,
          })
        );
        const chunks = [];
        for await (const chunk of res.Body) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
      const absolutePath = path.join(this.uploadDir, filePath);
      return await fs.promises.readFile(absolutePath);
    } catch (error) {
      throw new Error(`File download failed: ${error.message}`);
    }
  }
}

module.exports = new StorageService();
