exports.connectGarmin = async (req, res) => {
  try {
    // Implementación mock / placeholder
    res.json({ authUrl: 'https://connect.garmin.com/oauth' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.connectPolar = async (req, res) => {
  try {
    // Implementación mock / placeholder
    res.json({ authUrl: 'https://flow.polar.com/oauth' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};
