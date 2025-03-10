/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as path from 'path';
import {
  PostcssCliResources,
  RawCssLoader,
  RemoveHashPlugin,
  SuppressExtractedTextChunksWebpackPlugin,
} from '../../plugins/webpack';
import { BuildOptions } from '../build-options';
import { getOutputHashFormat, normalizeExtraEntryPoints } from './utils';
import { RemoveEmptyScriptsPlugin } from '../../plugins/remove-empty-scripts-plugin';
import { sassImplementation } from '../../../../sass';

const autoprefixer = require('autoprefixer');
const postcssImports = require('postcss-import');

// TODO(jack): Remove in Nx 13
type RuleSetRule = any;

/**
 * Enumerate loaders and their dependencies from this file to let the dependency validator
 * know they are used.
 *
 * require('style-loader')
 * require('postcss-loader')
 * require('stylus')
 * require('stylus-loader')
 * require('less')
 * require('less-loader')
 * require('node-sass')
 * require('sass-loader')
 */
// tslint:disable-next-line:no-big-function
export function getStylesConfig(
  root: string,
  buildOptions: BuildOptions,
  includePaths: string[]
) {
  // TODO(jack): Remove this in Nx 13 and go back to proper imports
  const {
    isWebpack5,
    MiniCssExtractPlugin,
  } = require('../../../../../webpack/entry');

  const entryPoints: { [key: string]: string[] } = {};
  const globalStylePaths: string[] = [];
  const extraPlugins = [];

  const cssSourceMap = buildOptions.sourceMap.styles;

  // Determine hashing format.
  const hashFormat = getOutputHashFormat(buildOptions.outputHashing as string);

  const postcssOptionsCreator = (sourceMap: boolean) => {
    return (loader) => ({
      map: sourceMap && {
        inline: true,
        annotation: false,
      },
      plugins: [
        postcssImports({
          addModulesDirectories: includePaths,
          resolve: (url: string) => (url.startsWith('~') ? url.substr(1) : url),
          load: (filename: string) => {
            return new Promise<string>((resolve, reject) => {
              loader.fs.readFile(filename, (err: Error, data: Buffer) => {
                if (err) {
                  reject(err);

                  return;
                }

                const content = data.toString();
                resolve(content);
              });
            });
          },
        }),
        PostcssCliResources({
          baseHref: buildOptions.baseHref,
          deployUrl: buildOptions.deployUrl,
          resourcesOutputPath: buildOptions.resourcesOutputPath,
          loader,
          filename: `[name]${hashFormat.file}.[ext]`,
        }),
        autoprefixer(),
      ],
    });
  };

  let lessPathOptions: { paths?: string[] } = {};

  if (includePaths.length > 0) {
    lessPathOptions = {
      paths: includePaths,
    };
  }

  // Process global styles.
  if (buildOptions.styles.length > 0) {
    const chunkNames: string[] = [];

    normalizeExtraEntryPoints(buildOptions.styles, 'styles').forEach(
      (style) => {
        const resolvedPath = path.resolve(root, style.input);
        // Add style entry points.
        if (entryPoints[style.bundleName]) {
          entryPoints[style.bundleName].push(resolvedPath);
        } else {
          entryPoints[style.bundleName] = [resolvedPath];
        }

        // Add non injected styles to the list.
        if (!style.inject) {
          chunkNames.push(style.bundleName);
        }

        // Add global css paths.
        globalStylePaths.push(resolvedPath);
      }
    );

    if (chunkNames.length > 0) {
      // Add plugin to remove hashes from lazy styles.
      extraPlugins.push(new RemoveHashPlugin({ chunkNames, hashFormat }));
    }
  }

  // set base rules to derive final rules from
  const baseRules: RuleSetRule[] = [
    { test: /\.css$/, use: [] },
    {
      test: /\.scss$|\.sass$/,
      use: [
        {
          loader: require.resolve('sass-loader'),
          options: {
            implementation: sassImplementation,
            sourceMap: cssSourceMap,
            sassOptions: {
              fiber: false,
              // bootstrap-sass requires a minimum precision of 8
              precision: 8,
              includePaths,
            },
          },
        },
      ],
    },
    {
      test: /\.less$/,
      use: [
        {
          loader: require.resolve('less-loader'),
          options: {
            sourceMap: cssSourceMap,
            javascriptEnabled: true,
            ...lessPathOptions,
          },
        },
      ],
    },
    {
      test: /\.styl$/,
      use: [
        {
          loader: require.resolve('stylus-loader'),
          options: {
            sourceMap: cssSourceMap,
            paths: includePaths,
          },
        },
      ],
    },
  ];

  // load component css as raw strings
  const componentsSourceMap = !!(
    cssSourceMap &&
    // Never use component css sourcemap when style optimizations are on.
    // It will just increase bundle size without offering good debug experience.
    !buildOptions.optimization.styles &&
    // Inline all sourcemap types except hidden ones, which are the same as no sourcemaps
    // for component css.
    !buildOptions.sourceMap.hidden
  );

  const rules: RuleSetRule[] = baseRules.map(({ test, use }) => ({
    exclude: globalStylePaths,
    test,
    use: [
      { loader: require.resolve('raw-loader') },
      // Including RawCssLoader here because per v4.x release notes for postcss-loader under breaking changes:
      // "loader output only CSS, so you need to use css-loader/file-loader/raw-loader to inject code inside bundle"
      RawCssLoader,
      {
        loader: require.resolve('postcss-loader'),
        options: {
          implementation: require('postcss'),
          postcssOptions: postcssOptionsCreator(componentsSourceMap),
        },
      },
      ...(use as any[]),
    ],
  }));

  // load global css as css files
  if (globalStylePaths.length > 0) {
    const globalSourceMap = !!cssSourceMap && !buildOptions.sourceMap.hidden;

    rules.push(
      ...baseRules.map(({ test, use }) => {
        return {
          include: globalStylePaths,
          test,
          use: [
            buildOptions.extractCss
              ? {
                  loader: MiniCssExtractPlugin.loader,
                  options: { esModule: true },
                }
              : require.resolve('style-loader'),
            RawCssLoader,
            {
              loader: require.resolve('postcss-loader'),
              options: {
                implementation: require('postcss'),
                postcssOptions: postcssOptionsCreator(globalSourceMap),
              },
            },
            ...(use as any[]),
          ],
        };
      })
    );
  }

  if (buildOptions.extractCss) {
    extraPlugins.push(
      // extract global css from js files into own css file
      new MiniCssExtractPlugin({ filename: `[name]${hashFormat.extract}.css` }),
      // suppress empty .js files in css only entry points
      isWebpack5
        ? new RemoveEmptyScriptsPlugin()
        : new SuppressExtractedTextChunksWebpackPlugin()
    );
  }

  return {
    entry: entryPoints,
    module: { rules },
    plugins: extraPlugins,
  };
}
