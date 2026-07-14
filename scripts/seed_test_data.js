const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { v4: uuidv4 } = require('uuid');

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Find or create the admin users
  const adminEmails = ['admin@jnsix.com']; // User mentioned admin@jnsix.com
  const users = [];

  for (const email of adminEmails) {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`Creating user ${email}...`);
      user = await prisma.user.create({
        data: {
          id: uuidv4(),
          email,
          name: email.split('@')[0],
          password: 'Password123!', // Ensure they can log in if needed
          role: 'ADMIN',
          subscriptionTier: 'PRO',
          stravaId: `mock_strava_${Math.floor(Math.random() * 100000)}`
        }
      });
    }
    users.push(user);
    
    // Ensure UserScore exists
    const userScore = await prisma.userScore.findUnique({ where: { userId: user.id } });
    if (!userScore) {
      await prisma.userScore.create({
        data: {
          userId: user.id,
          totalPoints: Math.floor(Math.random() * 5000) + 1000
        }
      });
    }
  }

  // 2. Generate Activities for each user
  const activityTypes = ['RUN', 'RIDE', 'SWIM'];
  
  for (const user of users) {
    console.log(`Generating data for ${user.email} (${user.id})...`);
    
    // Clear existing mock activities (optional, to avoid infinite growth, but let's just append)
    
    // Generate 20 activities
    const activitiesToCreate = [];
    for (let i = 0; i < 20; i++) {
      const type = activityTypes[Math.floor(Math.random() * activityTypes.length)];
      
      // Random date within the last 30 days
      const daysAgo = Math.floor(Math.random() * 30);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysAgo);
      
      const distanceKm = type === 'RIDE' ? (Math.random() * 40 + 10) : (Math.random() * 15 + 3);
      const movingTime = Math.floor(distanceKm * (type === 'RIDE' ? 150 : 300)); // Seconds
      const elevationM = Math.floor(Math.random() * 500);
      const averageHr = Math.floor(Math.random() * 40) + 120;
      
      const activityData = {
        userId: user.id,
        stravaId: `mock_${uuidv4()}`,
        name: `${type === 'RUN' ? 'Morning Run' : type === 'RIDE' ? 'Evening Ride' : 'Workout session'}`,
        type,
        startDate,
        distanceKm,
        movingTime,
        elevationM,
        averageHr,
        maxHr: averageHr + 20,
        calories: Math.floor(distanceKm * 60)
      };
      
      const activity = await prisma.activity.create({
        data: activityData
      });
      
      activitiesToCreate.push(activity);
      
      // Create Feed Post for this activity
      await prisma.post.create({
        data: {
          userId: user.id,
          activityId: activity.id,
          content: `Great ${type.toLowerCase()} today! Feeling strong. 💪`
        }
      });
    }
    
    // 3. Generate Competition Goals
    const compGoal = await prisma.competitionGoal.create({
      data: {
        userId: user.id,
        name: 'Maratón de Buenos Aires',
        type: 'RUN',
        distanceKm: 42.195,
        elevationM: 150,
        targetDate: new Date('2025-10-12'),
        targetTime: '03:30:00',
        terrainType: 'ROAD',
        notes: 'Targeting sub 3:30'
      }
    });

    console.log(`✅ Data generated for ${user.email}`);
  }

  console.log('✅ Seeding completed successfully.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
