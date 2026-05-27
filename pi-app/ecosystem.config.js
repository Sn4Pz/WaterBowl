module.exports = {
  apps: [
    {
      name: "waterbowl",
      script: "server.js",
      cwd: "/home/pi/WaterBowl",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
