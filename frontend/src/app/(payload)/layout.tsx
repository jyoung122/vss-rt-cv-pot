import React from 'react'
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts'
import type { ServerFunctionClient } from 'payload'
import config from '@/payload/payload.config'
import '@payloadcms/next/css'

type Args = {
  children: React.ReactNode
}

const importMap = {}

const serverFunction: ServerFunctionClient = async function (args) {
  'use server'
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

const Layout = ({ children }: Args) =>
  RootLayout({ config, children, importMap, serverFunction })

export default Layout
