const prisma = require('../lib/prisma');

// Subir una nueva historia (JSON con mediaUrl o multipart con archivo `media`)
const createStory = async (req, res) => {
  try {
    const userId = req.user.id;
    let { mediaUrl, mediaType, caption, activityId } = req.body;

    if (req.file) {
      // Siempre relativo: el cliente resuelve el host actual.
      mediaUrl = `/uploads/${req.file.filename}`;
      const mime = req.file.mimetype || '';
      const inferred = mime.startsWith('video/') ? 'VIDEO' : 'IMAGE';
      mediaType = (mediaType || inferred).toUpperCase();
      if (mediaType !== 'IMAGE' && mediaType !== 'VIDEO') {
        return res.status(400).json({ error: 'mediaType debe ser IMAGE o VIDEO' });
      }
    }

    if (!mediaUrl || !mediaType) {
      return res.status(400).json({ error: 'Faltan campos requeridos: mediaUrl y mediaType (o archivo media)' });
    }

    // Historias expiran en 24 horas
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const story = await prisma.story.create({
      data: {
        userId,
        mediaUrl,
        mediaType,
        caption: caption || (activityId ? `Actividad ${activityId}` : null),
        expiresAt,
      },
    });

    res.status(201).json(story);
  } catch (error) {
    console.error('[CREATE STORY ERROR]', error);
    res.status(500).json({ error: 'Error al crear la historia' });
  }
};

// Obtener historias activas (del usuario y de sus amigos)
const getFeedStories = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    // 1. Obtener amigos
    const friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { userId: userId, status: 'ACCEPTED' },
          { friendId: userId, status: 'ACCEPTED' }
        ]
      }
    });

    const friendIds = friendships.map(f => f.userId === userId ? f.friendId : f.userId);
    
    // Incluir también las propias historias del usuario
    const userIds = [...friendIds, userId];

    // 2. Traer historias activas, ordenadas por más reciente, agrupadas por usuario (opcional, agrupamos en frontend)
    const activeStories = await prisma.story.findMany({
      where: {
        userId: { in: userIds },
        expiresAt: { gt: now }
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            avatarUrl: true
          }
        },
        views: {
          where: { userId } // Para saber si yo ya la vi
        }
      },
      orderBy: {
        createdAt: 'asc' // Las más antiguas primero (para reproducirlas en orden cronológico)
      }
    });

    res.json(activeStories);
  } catch (error) {
    console.error('[GET FEED STORIES ERROR]', error);
    res.status(500).json({ error: 'Error al obtener historias' });
  }
};

// Registrar una vista a una historia
const viewStory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Usar upsert para evitar errores de duplicidad si se ve la misma historia múltiples veces
    await prisma.storyView.upsert({
      where: {
        storyId_userId: {
          storyId: id,
          userId
        }
      },
      update: {
        viewedAt: new Date()
      },
      create: {
        storyId: id,
        userId
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[VIEW STORY ERROR]', error);
    res.status(500).json({ error: 'Error al registrar vista de la historia' });
  }
};

module.exports = {
  createStory,
  getFeedStories,
  viewStory
};
