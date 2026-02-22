{/*
export const loginNotificationTemplate = (userName, loginTime) => {
  return {
    subject: "Login Notification",
    text: `Hello ${userName},\n\nYou have successfully logged in on ${loginTime}.\nIf this wasn't you, please reset your password immediately.`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 10px; color: #333;">
        <h2>Login Notification</h2>
        <p>Hello <strong>${userName}</strong>,</p>
        <p>You have successfully logged in on <strong>${loginTime}</strong>.</p>
        <p>If this wasn't you, please reset your password immediately.</p>
      </div>
    `
  };
};   */}


export const passwordResetOtpTemplate = (otp) => {
  return {
    subject: "Your Password Reset Code",
    text: `Your password reset code is: ${otp}. It will expire in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 10px; color: #333;">
        <h2>Password Reset Request</h2>
        <p>Your password reset code is: <strong>${otp}</strong></p>
        <p>This code will expire in 10 minutes.</p>
      </div>
    `
  };
};

export const agentWelcomeTemplate = (agentName, tempPassword, loginUrl) => {
  return {
    subject: "Welcome to Assur Assistance - Your Account Details",
    text: `Hello ${agentName},\n\nYour agent account has been created successfully!\n\nYour temporary password is: ${tempPassword}\n\nPlease log in at ${loginUrl} and change your password immediately.\n\nBest regards,\nAssur Assistance Team`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to Assur Assistance</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <p>Hello <strong>${agentName}</strong>,</p>
          <p>Your agent account has been created successfully! Here are your login details:</p>
          
          <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 15px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Login URL:</strong> <a href="${loginUrl}" style="color: #2196f3;">${loginUrl}</a></p>
            <p style="margin: 5px 0 0 0;"><strong>Temporary Password:</strong> <code style="background: #fff; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${tempPassword}</code></p>
          </div>
          
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;"><strong>⚠️ Important:</strong> Please log in and change your password immediately for security reasons.</p>
          </div>
          
          <p>If you have any questions, please contact your administrator.</p>
          
          <p>Best regards,<br>Assur Assistance Team</p>
        </div>
      </div>
    `
  };
};

export const passwordResetLinkTemplate = (agentName, resetLink) => {
  return {
    subject: "Password Reset Link - Assur Assistance",
    text: `Hello ${agentName},\n\nA password reset has been requested for your account.\n\nClick the link below to reset your password:\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.\n\nBest regards,\nAssur Assistance Team`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Password Reset Request</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <p>Hello <strong>${agentName}</strong>,</p>
          <p>A password reset has been requested for your account.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}" style="background: #2196f3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Reset Password</a>
          </div>
          
          <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;"><strong>⚠️ Note:</strong> This link will expire in 1 hour for security reasons.</p>
          </div>
          
          <p>If you didn't request this password reset, please ignore this email and contact your administrator.</p>
          
          <p>Best regards,<br>Assur Assistance Team</p>
        </div>
      </div>
    `
  };
};

