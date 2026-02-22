// emailService.js
import nodemailer from 'nodemailer';

let transporter = null;

// Initialize the email transporter
export const initializeEmailTransporter = (config) => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.EMAIL_HOST,
      port: Number(config.EMAIL_PORT),
      secure: config.EMAIL_SECURE === 'true',
      auth: {
        user: config.EMAIL_USER,
        pass: config.EMAIL_PASS,
      },
      tls: {
        ciphers: 'SSLv3', // can help if behind old proxy
        rejectUnauthorized: false
      }
    });
  }
  return transporter;
};

// Get the transporter instance
export const getEmailTransporter = () => {
  if (!transporter) {
    throw new Error('Email transporter not initialized. Make sure to call initializeEmailTransporter() first.');
  }
  return transporter;
};

// Function to send email
const sendEmail = async(to, subject, text, html) => {
    try {
        const emailTransporter = getEmailTransporter();
        
        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to,
            subject,
            text,
            html,
        };

        // Send email with retry mechanism
        let retries = 3;
        let success = false;
        let lastError;

        while (retries > 0 && !success) {
            try {
                await emailTransporter.sendMail(mailOptions);
                success = true;
            } catch (error) {
                lastError = error;
                retries--;
                if (retries > 0) await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
            }
        }

        if (!success) throw lastError;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error; // Re-throw error to handle it in the calling function
    }
};

export default sendEmail;