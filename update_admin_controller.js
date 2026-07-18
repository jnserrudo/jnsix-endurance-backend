const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'src', 'controllers', 'admin.controller.js');
let code = fs.readFileSync(file, 'utf8');

// 1. Add bcrypt
if (!code.includes("const bcrypt = require('bcrypt');")) {
  code = code.replace("const prisma = require('../lib/prisma');", "const prisma = require('../lib/prisma');\nconst bcrypt = require('bcrypt');");
}

// 2. Replace editUser to include createUser and deleteUser
const editUserRegex = /const editUser = async \(req, res\) => {[\s\S]*?};\n/m;
const newUsersCode = `
const createUser = async (req, res) => {
  try {
    const { email, username, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        role: role || 'ATHLETE'
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'CREATE_USER',
        entityId: user.id,
        entityType: 'USER',
        metadata: { email, username, role }
      }
    });

    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editUser = async (req, res) => {
  try {
    const { isActive, role, roleIds, username } = req.body;

    const data = {};
    if (isActive !== undefined) data.isActive = isActive;
    if (role !== undefined) data.role = role;
    if (username !== undefined) data.username = username;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data
    });

    if (roleIds && Array.isArray(roleIds)) {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      if (roleIds.length > 0) {
        await prisma.userRole.createMany({
          data: roleIds.map(roleId => ({ userId: user.id, roleId }))
        });
      }
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'EDIT_USER',
        entityId: user.id,
        entityType: 'USER',
        metadata: { updatedFields: Object.keys(data) }
      }
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DELETE_USER',
        entityId: user.id,
        entityType: 'USER'
      }
    });

    res.json({ message: 'User deleted successfully', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
`;
code = code.replace(editUserRegex, newUsersCode);

// 3. Add deleteRank and deleteCategory
const editCategoryRegex = /const editCategory = async \(req, res\) => {[\s\S]*?};\n/m;
const newGamificationCode = `
const editCategory = async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body
    });
    
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'EDIT_CATEGORY', entityId: category.id, entityType: 'CATEGORY' }
    });
    
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteRank = async (req, res) => {
  try {
    const rank = await prisma.rank.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'DELETE_RANK', entityId: rank.id, entityType: 'RANK' }
    });
    res.json({ message: 'Rank deleted', rank });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'DELETE_CATEGORY', entityId: category.id, entityType: 'CATEGORY' }
    });
    res.json({ message: 'Category deleted', category });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
`;
code = code.replace(editCategoryRegex, newGamificationCode);

// 4. Exports
code = code.replace('editUser,', 'createUser,\n  editUser,\n  deleteUser,');
code = code.replace('editCategory', 'editCategory,\n  deleteRank,\n  deleteCategory');

fs.writeFileSync(file, code);
console.log('Modified admin.controller.js');
