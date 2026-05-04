import { redmineScraper } from './src/services/redmine-scraper.service';

async function testJson() {
  try {
    const loggedIn = await redmineScraper.login();
    if (!loggedIn) {
      console.log('Login failed');
      // Even if login fails, let's just try to hit a public JSON API or mock what the structure looks like
    }
    
    // Instead of parsing HTML, let's just get the JSON
    // But since login fails for me, I can't. So let's look at standard Redmine JSON structure.
  } catch (err) {
    console.error(err);
  }
}

testJson();
