# Deploy Backend on Hostinger VPS (with MySQL on same server)

This guide deploys the AssurAssistance Node.js backend on a **Hostinger VPS** and creates the **MySQL database on the same VPS**.

---

## Prerequisites

- A Hostinger VPS (Linux, e.g. Ubuntu 22.04).
- SSH access (IP, username, password from Hostinger panel).
- Your backend code (Git repo or upload).

---

## Part 1: Connect to your Hostinger VPS

1. In **Hostinger hPanel**, go to **VPS** → your VPS → **SSH Access** (or **Access Details**). Note:
   - **IP address**
   - **Username** (often `root`)
   - **Password** (or use SSH key if you set one)

2. From your Mac Terminal (or PuTTY on Windows):

```bash
ssh root@YOUR_VPS_IP
```

Replace `YOUR_VPS_IP` with the IP from Hostinger. Enter the password when prompted.

---

## Part 2: Install Node.js (LTS)

On the VPS, run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should show v20.x
npm -v
```

---

## Part 3: Install MySQL and create database

### 3.1 Install MySQL

```bash
sudo apt install -y mysql-server
sudo systemctl start mysql
sudo systemctl enable mysql
```

### 3.2 Set MySQL root password (do not skip)

On Ubuntu/Debian, root may have **no password** at first. Set it explicitly:

1. Log in without a password (works right after install):

```bash
sudo mysql
```

2. In the MySQL shell, set a strong root password (replace `YourStrongRootPassword123!` with your own):

```sql
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'YourStrongRootPassword123!';
FLUSH PRIVILEGES;
EXIT;
```

3. From now on, use `sudo mysql -u root -p` and enter that password.

4. (Optional) Harden the server:

```bash
sudo mysql_secure_installation
```

- Enter the **root password** you just set when asked.
- Answer: Remove anonymous users? **Y** | Disallow root login remotely? **Y** | Remove test DB? **Y** | Reload privileges? **Y**.

### 3.3 Create database and app user

**Option A – Use the project script (after code is on the VPS)**

Edit the script and set your password, then run:

```bash
cd /opt/assurassistance-backend
nano scripts/hostinger_create_db.sql   # replace YOUR_STRONG_PASSWORD with your password
sudo mysql -u root -p < scripts/hostinger_create_db.sql
```

**Option B – Run SQL manually**

1. Log in to MySQL as root:

```bash
sudo mysql -u root -p
```

Enter the root password you set.

2. Run the following (replace `YOUR_STRONG_DB_PASSWORD` with a strong password you choose):

```sql
CREATE DATABASE IF NOT EXISTS assurassistance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'assurapp'@'localhost' IDENTIFIED BY 'YOUR_STRONG_DB_PASSWORD';
GRANT ALL PRIVILEGES ON assurassistance.* TO 'assurapp'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 3.4 Import the schema and create tables

On the VPS (after you have the backend code in Part 4):

```bash
cd /opt/assurassistance-backend
mysql -u root -p assurassistance < database_dump.sql
```

Enter the password you set for `assurapp`. This creates all tables.

### 3.5 (Optional) Seed admin user

```bash
# Edit seed_admin_user.sql to match your DB name if different, then:
mysql -u assurapp -p assurassistance < seed_admin_user.sql
```

Default admin: email `assur.assistances@gmail.com`, password `Admin@123`. Change after first login.

---

## Part 4: Upload backend code to the VPS

### Option A: Git (recommended)

On the VPS:

```bash
# Install git if needed
sudo apt install -y git

# Clone (use your repo URL; replace with actual URL)
cd /opt
sudo git clone https://github.com/saifali8152/assurassistance-backend.git
sudo mv assurassistance assurassistance-backend
sudo chown -R $USER:$USER assurassistance-backend
cd assurassistance-backend/backend
```

If the repo is private, use a deploy key or HTTPS with credentials.

### Option B: Upload via SCP from your Mac

From your **Mac** (in the project root):

```bash
scp -r /Applications/MAMP/htdocs/assurassistance/backend root@YOUR_VPS_IP:/opt/assurassistance-backend
```

Then on the VPS:

```bash
cd /opt/assurassistance-backend
```

### Option C: ZIP and upload

Zip the `backend` folder on your Mac, upload via Hostinger File Manager or SFTP, then on the VPS:

```bash
cd /opt
unzip backend.zip -d assurassistance-backend
cd assurassistance-backend
```

---

## Part 5: Configure environment variables

On the VPS, create the `.env` file in the backend folder:

```bash
cd /opt/assurassistance-backend   # or wherever you put the backend
nano .env
```

You can copy from `.env.example` in the repo, or paste the following and **edit** the values (especially DB and secrets):

```env
PORT=3000
NODE_ENV=production

# Database (same VPS – use localhost)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=assurassistance
DB_USER=assurapp
DB_PASSWORD=YOUR_STRONG_DB_PASSWORD

# JWT (generate a new secret for production)
JWT_SECRET=your-long-random-secret-at-least-32-chars
JWT_EXPIRES_IN=1h

# Email (your SMTP settings)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
EMAIL_FROM="AssurAssistance <your-email@gmail.com>"

# App URLs (your frontend and backend domains)
BASE_URL=https://your-backend-domain.com
FRONTEND_URL=https://assurassistancepro.org

# Optional
ADMIN_EMAIL=admin@example.com
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
MAX_FILE_SIZE=5242880
ALLOWED_FILE_TYPES=pdf,jpg,jpeg,png
```

Save and exit (Ctrl+O, Enter, Ctrl+X in nano).

---

## Part 6: Install dependencies and run the app

```bash
cd /opt/assurassistance-backend
npm install --production
```

Test run:

```bash
npm start
```

You should see “Connected to MySQL database” and “server is running on 3000”. Press Ctrl+C to stop.

---

## Part 7: Run with PM2 (keep backend running)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the app
cd /opt/assurassistance-backend
pm2 start server.js --name backend

# Auto-start on reboot
pm2 startup
pm2 save
```

Useful commands:

```bash
pm2 status
pm2 logs backend
pm2 restart backend
pm2 stop backend
```

---

## Part 8: Open firewall port (if you use a firewall)

If you want to reach the backend directly on port 3000 (for testing or reverse proxy):

```bash
sudo ufw allow 22
sudo ufw allow 3000
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

---

## Part 9: Use Nginx as reverse proxy (recommended for production)

So the app is served on port 80/443 with a domain (e.g. `api.yourdomain.com`).

### 9.1 Install Nginx

```bash
sudo apt install -y nginx
```

### 9.2 Create Nginx config

```bash
sudo nano /etc/nginx/sites-available/assurassistance-backend
```

Paste (replace `api.yourdomain.com` and `YOUR_VPS_IP`):

```nginx
server {
    listen 80;
    server_name backend-api.assurassistancepro.org;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/assurassistance-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Point your domain’s DNS **A record** for your API hostname (e.g. `backend-api.assurassistancepro.org`) to your VPS IP. HTTP should work first.

### 9.3 SSL certificate (HTTPS with Let’s Encrypt)

1. Install Certbot and the Nginx plugin:

```bash
sudo apt install -y certbot python3-certbot-nginx
```

2. Get a certificate (replace with your API domain). Certbot will edit Nginx for you:

```bash
sudo certbot --nginx -d backend-api.assurassistancepro.org
```

- Enter your email when asked.
- Agree to terms; choose whether to share email with EFF.
- Choose to redirect HTTP to HTTPS (recommended: option 2).

3. Certbot adds a `listen 443 ssl` server block and the certificate paths. Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

4. (Optional) Test auto-renewal:

```bash
sudo certbot renew --dry-run
```

Your API will be available at **https://backend-api.assurassistancepro.org**. Set `BASE_URL` in `.env` to that URL.

---

## Part 10: Create uploads folder (if the app writes files)

```bash
cd /opt/assurassistance-backend
mkdir -p uploads
chmod 755 uploads
```

---

## Checklist summary

| Step | Action |
|------|--------|
| 1 | SSH into Hostinger VPS |
| 2 | Install Node.js 20 LTS |
| 3 | Install MySQL, secure it, create DB `assurassistance` and user `assurapp` |
| 4 | Import `database_dump.sql`, optionally `seed_admin_user.sql` |
| 5 | Upload backend code to `/opt/assurassistance-backend` |
| 6 | Create `.env` with DB_HOST=localhost and your settings |
| 7 | `npm install --production` and test with `npm start` |
| 8 | Run with PM2: `pm2 start server.js --name backend` and `pm2 save` |
| 9 | (Optional) UFW allow 22, 80, 443, 3000 |
| 10 | (Optional) Nginx reverse proxy and DNS for your API domain |
| 11 | (Optional) SSL cert: `certbot --nginx -d your-api-domain.com` |

---

## Troubleshooting

- **`ERROR: ASCII '\0' appeared in the statement` when importing `database_dump.sql`:** The file is in UTF-16 (or has null bytes). On the VPS, convert it to UTF-8 and re-import:
  ```bash
  cd /opt/assurassistance-backend
  iconv -f UTF-16LE -t UTF-8 database_dump.sql > database_dump_utf8.sql
  mv database_dump_utf8.sql database_dump.sql
  mysql -u root -p assurassistance < database_dump.sql
  ```
  Or re-upload the `database_dump.sql` from your project (it should be UTF-8 without BOM), then run the `mysql ... < database_dump.sql` command again.
- **MySQL root has empty password:** Log in with `sudo mysql` (no `-p`). Then run: `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'YourNewStrongPassword';` then `FLUSH PRIVILEGES;` and `EXIT;`. After that, use `sudo mysql -u root -p` with the new password.
- **Database connection failed:** Check `.env` (DB_HOST=localhost, DB_USER, DB_PASSWORD, DB_NAME). Test with `mysql -u assurapp -p assurassistance -e "SELECT 1"`.
- **Port 3000 not reachable:** Ensure UFW allows 3000 (or use Nginx proxy); check `pm2 logs backend`.
- **Permission denied on uploads:** Ensure `uploads` exists and is writable by the user running Node.

Your backend will be at `http://YOUR_VPS_IP:3000`, or at `https://your-api-domain.com` if you set up Nginx, DNS, and SSL (certbot).


ssh root@187.77.172.212
?Eg7ouw'CcC?Dni4UKm8