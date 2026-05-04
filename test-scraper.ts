import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

async function testScraper() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    baseURL: 'https://pms.codemagen.net',
    jar,
    withCredentials: true,
  }));

  try {
    const loginPage = await client.get('/login');
    const $ = cheerio.load(loginPage.data);
    const csrfToken = $('input[name="authenticity_token"]').val() as string;
    
    console.log('Got CSRF Token:', csrfToken);

    // The login form in Redmine actually requires these fields exactly
    const data = new URLSearchParams();
    data.append('utf8', '✓');
    data.append('authenticity_token', csrfToken);
    data.append('back_url', 'https://pms.codemagen.net/');
    data.append('username', 'sarves@codemagen.com');
    data.append('password', 'codemagen@123');
    data.append('autologin', '1');
    data.append('login', 'Login');

    const loginRes = await client.post('/login', data.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://pms.codemagen.net/login',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      },
      maxRedirects: 5,
    });

    console.log('Login Result URL:', loginRes.request.res.responseUrl);
    
    // Check if we have the "logged in as" span
    const $loggedIn = cheerio.load(loginRes.data);
    const loggedInUser = $loggedIn('#loggedas').text().trim();
    console.log('Logged in as text:', loggedInUser);

    if (!loggedInUser) {
        console.log('Flash message:', $loggedIn('#flash_error').text().trim());
    }

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

testScraper();
