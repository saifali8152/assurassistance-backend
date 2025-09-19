// emailService.js
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

// Create a transporter object using SMTP transport
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        ciphers: 'SSLv3', // can help if behind old proxy
        rejectUnauthorized: false
    }
});

// Function to send email
const sendEmail = async(to, subject, text, html) => {
    try {
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
                await transporter.sendMail(mailOptions);
                success = true;
                console.log('Email sent successfully!');
            } catch (error) {
                lastError = error;
                console.error(`Email sending attempt failed (${4-retries}/3):`, error.message);
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