//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

// Loads COGNITRACE_API_URL (and anything else) from a local .env file into process.env for local
// builds (yarn compile / watch / package). Never overrides a variable already set in the
// environment, so CI — which sets it directly from a repo secret — is unaffected. No-op if there's
// no .env file.
require('dotenv').config();

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    // Bakes the ingest API's base URL into the bundle at build/package time, from whichever
    // environment set COGNITRACE_API_URL when webpack ran — so a packaged .vsix already knows
    // where to send logs and students never have to configure a URL (or an API key: their user
    // code doubles as the key, see api-client.ts).
    new webpack.DefinePlugin({
      'process.env.COGNITRACE_API_URL': JSON.stringify(process.env.COGNITRACE_API_URL || '')
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];