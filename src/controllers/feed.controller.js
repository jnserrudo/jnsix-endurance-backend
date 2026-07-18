const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

const PAGE_SIZE = 20;

const getFeed = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * PAGE_SIZE;

    // Obtener IDs de amigos
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }]
      }
    });
    const friendIds = friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));

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
        visibility: { in: ['PUBLIC', 'FRIENDS'] }
      },
      orderBy: { startDate: 'desc' },
      take: PAGE_SIZE,
      include: {
        user: { select: { id: true, email: true } },
        _count: { select: { comments: true } }
      }
    });

    const posts = await prisma.post.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { userId },
          { userId: { in: friendIds } },
          { activity: { visibility: { in: ['PUBLIC', 'FRIENDS'] } } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      include: {
        user: { select: { id: true, email: true } },
        activity: { select: { id: true, name: true } },
        _count: { select: { comments: true } }
      }
    });

    const combined = [
      ...activities.map((a) => ({ type: 'ACTIVITY', data: a, date: a.startDate })),
      ...posts.map((p) => ({ type: 'POST', data: p, date: p.createdAt }))
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(skip, skip + PAGE_SIZE);

    res.json({ feed: combined });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { content, activityId } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'content is required' });
    }

    const post = await prisma.post.create({
      data: { userId, content, activityId: activityId || null },
      include: {
        user: { select: { id: true, email: true } },
        activity: { select: { id: true, name: true } }
      }
    });

    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
