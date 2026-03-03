# MySQL remote access from EC2 – VPS with ISPConfig

Your database is on **vps108893.serveur-vps.net** (ISPConfig) and your app runs on **EC2**. Do these steps **on the VPS** (via SSH). No need to find any “first option” in ISPConfig.

---

## I only have ISPConfig access (no SSH)

If you can log in only to **ISPConfig** and not to the server (no SSH, no serveur-vps.net panel), do the following.

### What you can do in ISPConfig

**1. Add your EC2 IP to the database Remote access (if your panel has it)**

- In ISPConfig go to **Sites** (or **Websites**).
- Open the **site** that uses the database `c0ass0223`.
- In the left menu click **Databases** (or **Database**).
- Click the database **c0ass0223** to edit it.
- Look for a field named **Remote access**, **Remote Access IPs**, or **Allowed hosts**.
- If you find it: enter your **EC2 public IP** (one per line or comma-separated, no spaces). Save.
- If that option is not there, skip to step 2.

**2. Create the MySQL user for remote access via phpMyAdmin**

- In ISPConfig, under the same site or under **Databases**, open **phpMyAdmin** (button or link).
- Log in with your database user/password if asked.
- Go to the **User accounts** tab.
- Click **Add user account**.
  - **User name:** `c0ass0223` (or the same user you already use for this database).
  - **Host name:** choose **Any host** (`%`) **or** enter your **EC2 public IP**.
  - **Password:** set the same password as in your backend `.env` (e.g. `fP(jsu_RooT))`).
  - Under **Database for user account** select **Grant all privileges on database c0ass0223** (or your DB name).
- Click **Go** / **Create user**.

So from ISPConfig you can ensure the **MySQL user** is allowed to connect from EC2 (or from anywhere with `%`).

### What you cannot do from ISPConfig

These must be done on the server (or by the company that manages the VPS):

- **Open port 3306** in the firewall for your EC2 IP.
- **Set MySQL to listen on all interfaces** (`bind-address = 0.0.0.0`) and restart MySQL.

Without these, EC2 will not be able to reach MySQL even if the user is correct.

### What to do next

**Contact whoever manages the server** (e.g. **serveur-vps.net** support, or your IT/hoster). Send them:

1. Your **EC2 public IP** (the one your backend runs on).
2. This request (you can copy-paste):  
   - Please open **TCP port 3306** for our MySQL server so that only our application server can connect: allow inbound from IP **[paste your EC2 IP]**.  
   - Please set MySQL/MariaDB to accept remote connections: in the MySQL config set **bind-address = 0.0.0.0** (in the `[mysqld]` section), then restart MySQL/MariaDB.
3. (Optional) If they ask: The database user **c0ass0223** already has remote access from that IP (or from any host) – we configured it from ISPConfig / phpMyAdmin.

After they confirm the firewall and MySQL bind-address are done, test from EC2:

```bash
nc -zv vps108893.serveur-vps.net 3306
```

If that connects, restart your backend and try the app again.

---

## SSH is not in ISPConfig – where to get it

**There is no “SSH user” or SSH settings in ISPConfig.** ISPConfig is a panel for websites, databases, and mail on the server. It does **not** provide the main server (root) login.

- **ISPConfig has “Shell users”** (under **Sites** → your site → **Command Line** / **Shell user**). Those are for SFTP/shell access **to that website’s folder only**. They are usually restricted (jailed) and **cannot** run `sudo`, edit MySQL config, or open the firewall. So they are **not** what you need for the steps below.
- **The login you need** (to run firewall and MySQL commands on the whole server) is the **VPS server login**, given by **who hosts the VPS** – in your case **serveur-vps.net**, not ISPConfig.

So: **do not look for SSH in ISPConfig.** Get the server access from the VPS provider.

### Where to get the server (SSH) login

1. Log in to **serveur-vps.net** (the company that sold you the VPS).
2. Open your **VPS / server** in their **client area** or **dashboard** (not inside ISPConfig).
3. Look for something like: **Access**, **SSH**, **Root password**, **Credentials**, **Connection details**, **Server info**, **VPS details**, or **Manage**.
4. There they show (or let you set):
   - **Host:** `vps108893.serveur-vps.net` or an IP
   - **User:** often `root`
   - **Password:** root or SSH password

That’s the username and password you use in Terminal (or PuTTY) to connect to the server.

### Where to run SSH

- **On your Mac:** `Cmd + Space` → type **Terminal** → Enter, then run the `ssh` command below.
- **On Windows:** Use **PowerShell** or install [PuTTY](https://www.putty.org/) and connect to `vps108893.serveur-vps.net` on port 22.

### Connect from Terminal (Mac/Linux)

```bash
ssh defaultassurasspro@vps108893.serveur-vps.net
```

(Use the username from serveur-vps.net if it’s not `root`.) Enter the password when asked.

### If serveur-vps.net doesn’t give you SSH

- **Web console:** In **serveur-vps.net** (not ISPConfig), look for **Console**, **Web terminal**, **VNC**, or **Open terminal** – that’s a browser shell on the VPS. Use it to run the commands from Step 2 onward.
- **Ask the host:** Contact **serveur-vps.net** support and ask them to: (1) open port 3306 for your EC2 IP, (2) set MySQL `bind-address = 0.0.0.0` and restart MySQL, (3) create user `c0ass0223` with host = your EC2 IP (or `%`) and grant on `c0ass0223.*`. Send them your EC2 public IP and DB password.

---

## Step 1: SSH into the VPS (or use web console)

```bash
ssh YOUR_USERNAME@vps108893.serveur-vps.net
```

Use the SSH username and password from **serveur-vps.net** (e.g. `root`).

---

## Step 2: Open port 3306 in the firewall

**If the VPS uses UFW:**

```bash
# Replace YOUR_EC2_PUBLIC_IP with your real EC2 public IP (e.g. 3.110.xxx.xxx)
sudo ufw allow from 13.244.109.125 to any port 3306 comment 'MySQL from EC2'
sudo ufw reload
sudo ufw status
```

**If the VPS uses firewalld:**

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="YOUR_EC2_PUBLIC_IP" port port="3306" protocol="tcp" accept'
sudo firewall-cmd --reload
```

**If you don’t use UFW/firewalld**, the server may rely on the hoster’s firewall (e.g. in their panel). In that case open **TCP port 3306** from your **EC2 public IP** in that panel.

---

## Step 3: Make MySQL listen on all interfaces

1. Find the config file:

```bash
sudo mysql --version
# Then one of:
sudo nano /etc/mysql/mariadb.conf.d/50-server.cnf   # MariaDB
# or
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf        # MySQL
```

2. Find the line:

```ini
bind-address = 127.0.0.1
```

Change it to:

```ini
bind-address = 0.0.0.0
```

If the line is missing, add `bind-address = 0.0.0.0` under the `[mysqld]` section.

3. Restart MySQL:

```bash
sudo systemctl restart mysql
# or
sudo systemctl restart mariadb
```

---

## Step 4: Allow the DB user to connect from EC2 (MySQL)

Log in to MySQL as root (password from your ISPConfig/setup):

```bash
sudo mysql -u root -p
```

In the MySQL shell run (replace with your real values):

- **EC2 public IP** → e.g. `52.1.2.3`
- **Password** → same as in your backend `.env` (e.g. `fP(jsu_RooT))`)

```sql
-- Allow user c0ass0223 to connect from your EC2 IP only (recommended)
CREATE USER IF NOT EXISTS 'c0ass0223'@'YOUR_EC2_PUBLIC_IP' IDENTIFIED BY 'fP(jsu_RooT))';
GRANT ALL PRIVILEGES ON c0ass0223.* TO 'c0ass0223'@'YOUR_EC2_PUBLIC_IP';
FLUSH PRIVILEGES;
EXIT;
```

**If you don’t want to lock to one IP** (less secure):

```sql
CREATE USER IF NOT EXISTS 'c0ass0223'@'%' IDENTIFIED BY 'fP(jsu_RooT))';
GRANT ALL PRIVILEGES ON c0ass0223.* TO 'c0ass0223'@'%';
FLUSH PRIVILEGES;
EXIT;
```

---

## Step 5: Test from EC2

On your **EC2** instance:

```bash
nc -zv vps108893.serveur-vps.net 3306
```

- If it says **succeeded** or **open**, the network and firewall are OK. Restart your backend on EC2 (`pm2 restart backend`) and try the app again.
- If it **times out**, port 3306 is still blocked (firewall on VPS or at the hoster).

---

## Summary checklist

| Step | Where   | Action |
|------|--------|--------|
| 1    | Your PC | SSH into VPS |
| 2    | VPS     | Open TCP 3306 from EC2 IP (UFW/firewalld or hoster panel) |
| 3    | VPS     | Set `bind-address = 0.0.0.0` in MySQL config and restart MySQL |
| 4    | VPS     | In MySQL: `CREATE USER 'c0ass0223'@'EC2_IP'` (or `@'%'`) and `GRANT` on `c0ass0223.*` |
| 5    | EC2     | Run `nc -zv vps108893.serveur-vps.net 3306` then restart backend |

No ISPConfig GUI options are required for this to work.
