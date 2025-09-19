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
};
