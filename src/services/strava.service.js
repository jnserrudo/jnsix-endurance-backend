const axios = require('axios');

class StravaService {
  constructor() {
    this.clientId = process.env.STRAVA_CLIENT_ID;
    this.clientSecret = process.env.STRAVA_CLIENT_SECRET;
    this.redirectUri = process.env.STRAVA_REDIRECT_URI;
    this.baseUrl = 'https://www.strava.com/api/v3';
  }

  getAuthorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'read,activity:read_all,profile:read_all',
      state: state || ''
    });

    return `https://www.strava.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeToken(code) {
    try {
      const response = await axios.post('https://www.strava.com/oauth/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        grant_type: 'authorization_code'
      });

      return response.data;
    } catch (error) {
      throw new Error(`Strava token exchange failed: ${error.message}`);
    }
  }

  async refreshToken(refreshToken) {
    try {
      const response = await axios.post('https://www.strava.com/oauth/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      return response.data;
    } catch (error) {
      throw new Error(`Strava token refresh failed: ${error.message}`);
    }
  }

  async getAthlete(accessToken) {
    try {
      const response = await axios.get(`${this.baseUrl}/athlete`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get athlete: ${error.message}`);
    }
  }

  async getActivity(activityId, accessToken) {
    try {
      const response = await axios.get(`${this.baseUrl}/activities/${activityId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get activity: ${error.message}`);
    }
  }

  async getActivities(accessToken, page = 1, perPage = 30, afterDate = null) {
    try {
      const params = { page, per_page: perPage };
      
      // Agregar parámetro 'after' si se proporciona una fecha
      if (afterDate) {
        params.after = Math.floor(afterDate.getTime() / 1000); // Convertir a timestamp Unix
      }
      
      const response = await axios.get(`${this.baseUrl}/athlete/activities`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params
      });

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get activities: ${error.message}`);
    }
  }

  async getActivityStreams(activityId, accessToken, streamTypes = ['time', 'distance', 'altitude', 'heartrate', 'velocity_smooth']) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/activities/${activityId}/streams`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            keys: streamTypes.join(','),
            key_by_type: true
          }
        }
      );

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get activity streams: ${error.message}`);
    }
  }

  async getAthleteActivities(accessToken, perPage = 30) {
    return this.getActivities(accessToken, 1, perPage);
  }

  parseStravaActivityUrl(url) {
    const match = url.match(/strava\.com\/activities\/(\d+)/);
    return match ? match[1] : null;
  }
}

module.exports = new StravaService();
