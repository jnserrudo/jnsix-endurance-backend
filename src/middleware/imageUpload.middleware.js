const multer = require('multer');
const path = require('path');

const storage = multer.memoryStorage();

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  const mimeOk = mime.startsWith('image/');
  const extOk = !ext || ALLOWED_EXT.has(ext);

  if (mimeOk || (ext && extOk)) {
    cb(null, true);
    return;
  }

  cb(
    new Error(
      'Formato no soportado. Usá JPG, PNG o WEBP (en iPhone evitá HEIC puro si falla).'
    ),
    false
  );
};

const imageUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

function translateUploadError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'La imagen es demasiado grande. Probá con otra de hasta 8 MB.',
        code: 'IMAGE_TOO_LARGE',
      });
    }
    return res.status(400).json({
      error: 'No se pudo procesar la imagen. Intentá con otro archivo.',
      code: 'IMAGE_UPLOAD_ERROR',
    });
  }

  if (err?.message && /formato|jpg|png|webp|heic|image|soportado/i.test(err.message)) {
    return res.status(400).json({
      error: err.message,
      code: 'IMAGE_TYPE_INVALID',
    });
  }

  console.error('[imageUpload]', err);
  return res.status(500).json({
    error: 'No pudimos subir la imagen. Intentá de nuevo.',
    code: 'IMAGE_UPLOAD_FAILED',
  });
}

/**
 * Wrapper que captura errores de Multer y responde JSON en español.
 * Uso: router.post('/me/avatar', uploadImageField('image'), controller)
 */
function uploadImageField(fieldName = 'image') {
  const run = imageUpload.single(fieldName);
  return (req, res, next) => {
    run(req, res, (err) => {
      if (err) return translateUploadError(err, res);
      return next();
    });
  };
}

module.exports = imageUpload;
module.exports.uploadImageField = uploadImageField;
module.exports.translateUploadError = translateUploadError;
