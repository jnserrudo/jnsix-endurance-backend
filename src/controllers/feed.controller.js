const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

const PAGE_SIZE = 20;

const getFeed = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, q } = req.query;
    const skip = (parseInt(page) - 1) * PAGE_SIZE;
    const searchTerm = q ? q.trim() : '';

    // Obtener IDs de amigos
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }]
      }
    });
    const friendIds = friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));

    // Filtro de búsqueda por texto (insensible a mayúsculas en Prisma: mode: 'insensitive')
    const searchFilter = searchTerm
      ? { OR: [{ name: { contains: searchTerm, mode: 'insensitive' } }, { description: { contains: searchTerm, mode: 'insensitive' } }] }
      : {};
    const postSearchFilter = searchTerm
      ? { content: { contains: searchTerm, mode: 'insensitive' } }
      : {};

    // IDs de grupos/comunidades a los que pertenece el usuario
    const groupIds = (
      await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } })
    ).map((g) => g.groupId);
    const communityIds = (
      await prisma.communityMember.findMany({ where: { userId }, select: { communityId: true } })
    ).map((c) => c.communityId);

    // Feed: actividades publicas/de amigos + posts propios/de amigos
    const activities = await prisma.activity.findMany({
      where: {
        userId: { in: [...friendIds, userId] },
        visibility: { in: ['PUBLIC', 'FRIENDS'] },
        ...searchFilter
      },
      orderBy: { startDate: 'desc' },
      take: skip + PAGE_SIZE,
      include: {
        user: { select: { id: true, email: true } },
        _count: { select: { comments: true } }
      }
    });

    const posts = await prisma.post.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ...postSearchFilter,
        OR: [
          { userId },
          { userId: { in: friendIds } },
          { activity: { visibility: { in: ['PUBLIC', 'FRIENDS'] } } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: skip + PAGE_SIZE,
      include: {
        user: { select: { id: true, email: true } },
        activity: { select: { id: true, name: true } },
        _count: { select: { comments: true } }
      }
    });

    // Determinar si el usuario actual ya reacciono a cada actividad/post
    const activityIds = activities.map((a) => a.id);
    const postIds = posts.map((p) => p.id);

    const myReactions = await prisma.reaction.findMany({
      where: {
        userId,
        OR: [
          { targetType: 'ACTIVITY', targetId: { in: activityIds } },
          { targetType: 'POST', targetId: { in: postIds } }
        ]
      },
      select: { targetType: true, targetId: true }
    });
    const reactedActivityIds = new Set(
      myReactions.filter((r) => r.targetType === 'ACTIVITY').map((r) => r.targetId)
    );
    const reactedPostIds = new Set(
      myReactions.filter((r) => r.targetType === 'POST').map((r) => r.targetId)
    );

    const reactionCounts = await prisma.reaction.groupBy({
      by: ['targetType', 'targetId'],
      where: {
        OR: [
          { targetType: 'ACTIVITY', targetId: { in: activityIds } },
          { targetType: 'POST', targetId: { in: postIds } }
        ]
      },
      _count: { id: true }
    });
    
    const reactionCountMap = {};
    for (const row of reactionCounts) {
      reactionCountMap[`${row.targetType}_${row.targetId}`] = row._count.id;
    }

    const combined = [
      ...activities.map((a) => ({
        type: 'ACTIVITY',
        data: { 
          ...a, 
          hasReacted: reactedActivityIds.has(a.id),
          _count: { ...a._count, reactions: reactionCountMap[`ACTIVITY_${a.id}`] || 0 }
        },
        date: a.startDate
      })),
      ...posts.map((p) => ({
        type: 'POST',
        data: { 
          ...p, 
          hasReacted: reactedPostIds.has(p.id),
          _count: { ...p._count, reactions: reactionCountMap[`POST_${p.id}`] || 0 }
        },
        date: p.createdAt
      }))
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(skip, skip + PAGE_SIZE);

    res.json({ feed: combined });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { content, activityId } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'content is required' });
    }

    let imageUrl = null;
    if (req.file) {
      const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
      imageUrl = `${backendUrl}/uploads/${req.file.filename}`;
    }

    const post = await prisma.post.create({
      data: { userId, content, activityId: activityId || null, imageUrl },
      include: {
        user: { select: { id: true, email: true } },
        activity: { select: { id: true, name: true } }
      }
    });

    res.status(201).json(post);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listComments = async (req, res) => {
  try {
    const { targetType, targetId } = req.query;

    const where = {
      isActive: true,
      deletedAt: null
    };
    if (targetType === 'POST') where.postId = targetId;
    else if (targetType === 'ACTIVITY') where.activityId = targetId;

    const comments = await prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true } } }
    });

    res.json(comments);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetType, targetId, content } = req.body;

    if (!targetType || !targetId || !content) {
      return res.status(400).json({ error: 'targetType, targetId and content are required' });
    }

    const data = { userId, content };
    if (targetType === 'POST') data.postId = targetId;
    else if (targetType === 'ACTIVITY') data.activityId = targetId;
    else {
      return res.status(400).json({ error: 'targetType must be POST or ACTIVITY' });
    }

    const comment = await prisma.comment.create({
      data,
      include: { user: { select: { id: true, email: true } } }
    });

    // Notificar al dueño del contenido (post o actividad)
    let ownerId = null;
    if (targetType === 'POST') {
      const post = await prisma.post.findUnique({ where: { id: targetId }, select: { userId: true } });
      ownerId = post?.userId;
    } else if (targetType === 'ACTIVITY') {
      const activity = await prisma.activity.findUnique({ where: { id: targetId }, select: { userId: true } });
      ownerId = activity?.userId;
    }

    if (ownerId && ownerId !== userId) {
      await notify(ownerId, 'COMMENT', {
        title: 'Nuevo comentario',
        body: `${req.user.email} comento tu ${targetType.toLowerCase()}`,
        payload: { targetType, targetId, commentId: comment.id }
      });
    }

    res.status(201).json(comment);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listReactions = async (req, res) => {
  try {
    const { targetType, targetId } = req.query;

    const reactions = await prisma.reaction.findMany({
      where: { targetType, targetId },
      include: { user: { select: { id: true, email: true } } }
    });

    res.json(reactions);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const toggleReaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetType, targetId, type = 'LIKE' } = req.body;

    if (!targetType || !targetId) {
      return res.status(400).json({ error: 'targetType and targetId are required' });
    }

    const existing = await prisma.reaction.findUnique({
      where: { userId_targetType_targetId: { userId, targetType, targetId } }
    });

    if (existing) {
      await prisma.reaction.delete({ where: { id: existing.id } });
      return res.json({ removed: true });
    }

    const reaction = await prisma.reaction.create({
      data: { userId, targetType, targetId, type },
      include: { user: { select: { id: true, email: true } } }
    });

    // Notificar al dueño
    let ownerId = null;
    if (targetType === 'POST') {
      const post = await prisma.post.findUnique({ where: { id: targetId }, select: { userId: true } });
      ownerId = post?.userId;
    } else if (targetType === 'ACTIVITY') {
      const activity = await prisma.activity.findUnique({ where: { id: targetId }, select: { userId: true } });
      ownerId = activity?.userId;
    } else if (targetType === 'COMMENT') {
      const comment = await prisma.comment.findUnique({ where: { id: targetId }, select: { userId: true } });
      ownerId = comment?.userId;
    }

    if (ownerId && ownerId !== userId) {
      await notify(ownerId, 'REACTION', {
        title: 'Nueva reaccion',
        body: `${req.user.email} reacciono a tu ${targetType.toLowerCase()}`,
        payload: { targetType, targetId, reactionId: reaction.id }
      });
    }

    res.status(201).json(reaction);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updatePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = req.params.id;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'content is required' });

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ error: 'Post not found' });

    if (post.userId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not authorized to update this post' });
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: { content }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deletePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = req.params.id;

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ error: 'Post not found' });

    if (post.userId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not authorized to delete this post' });
    }

    await prisma.post.update({
      where: { id: postId },
      data: { isActive: false, deletedAt: new Date() }
    });

    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const commentId = req.params.id;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'content is required' });

    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    if (comment.userId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not authorized to update this comment' });
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { content }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteComment = async (req, res) => {
  try {
    const userId = req.user.id;
    const commentId = req.params.id;

    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    if (comment.userId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Not authorized to delete this comment' });
    }

    await prisma.comment.update({
      where: { id: commentId },
      data: { isActive: false, deletedAt: new Date() }
    });

    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getFeed,
  createPost,
  listComments,
  createComment,
  listReactions,
  toggleReaction,
  updatePost,
  deletePost,
  updateComment,
  deleteComment
};
